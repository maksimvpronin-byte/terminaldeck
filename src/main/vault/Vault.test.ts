import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EncryptedPayload } from './crypto'

/**
 * The vault asks Electron for its directory on every operation rather than once
 * at import, so a getter that reads a variable is enough to point it at a
 * temporary one. `vi.mock` is hoisted above this file's own statements, but the
 * factory only runs when `electron` is first imported — which, thanks to the
 * dynamic import below, is after the directory exists.
 */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-vault-'))
const { vault, WrongPasswordError } = await import('./Vault')

const FILE = join(userData, 'vault.json')
const OLD = 'correct horse battery staple'
const NEW = 'a different master password'

interface StoredVault {
  salt: string
  verifier: EncryptedPayload
  secrets: Record<string, EncryptedPayload>
}

function onDisk(): StoredVault {
  return JSON.parse(readFileSync(FILE, 'utf8')) as StoredVault
}

beforeEach(() => {
  vault.lock()
  rmSync(FILE, { force: true })
  rmSync(`${FILE}.tmp`, { force: true })
})

describe('vault', () => {
  it('reports whether it exists and whether it is open', async () => {
    expect(vault.status()).toEqual({ exists: false, unlocked: false })
    await vault.create(OLD)
    expect(vault.status()).toEqual({ exists: true, unlocked: true })
    vault.lock()
    expect(vault.status()).toEqual({ exists: true, unlocked: false })
  })

  it('round-trips a secret through a lock and an unlock', async () => {
    await vault.create(OLD)
    vault.setSecret('host-1', 'hunter2')
    vault.lock()

    await vault.unlock(OLD)
    expect(vault.getSecret('host-1')).toBe('hunter2')
  })

  it('answers undefined for a reference it does not hold', async () => {
    await vault.create(OLD)
    expect(vault.getSecret('never-stored')).toBeUndefined()
  })

  it('refuses every operation while locked', async () => {
    await vault.create(OLD)
    vault.lock()

    expect(() => vault.getSecret('host-1')).toThrow(/locked/i)
    expect(() => vault.setSecret('host-1', 'hunter2')).toThrow(/locked/i)
    expect(() => vault.allSecrets()).toThrow(/locked/i)
    expect(() => vault.deleteSecret('host-1')).toThrow(/locked/i)
    await expect(vault.changePassword(OLD, NEW)).rejects.toThrow(/locked/i)
  })

  it('refuses the wrong master password and stays shut', async () => {
    await vault.create(OLD)
    vault.setSecret('host-1', 'hunter2')
    vault.lock()

    await expect(vault.unlock('not it')).rejects.toThrow(WrongPasswordError)
    expect(vault.status().unlocked).toBe(false)

    // The failed attempt left the file alone.
    await vault.unlock(OLD)
    expect(vault.getSecret('host-1')).toBe('hunter2')
  })

  it('forgets a secret on request, and keeps the others', async () => {
    await vault.create(OLD)
    vault.setSecret('host-1', 'one')
    vault.setSecret('host-2', 'two')

    vault.deleteSecret('host-1')

    expect(vault.getSecret('host-1')).toBeUndefined()
    expect(vault.getSecret('host-2')).toBe('two')
    expect(Object.keys(onDisk().secrets)).toEqual(['host-2'])
  })

  it('hands out every secret in the clear for an export', async () => {
    await vault.create(OLD)
    vault.setSecret('host-1', 'one')
    vault.setSecret('host-2', 'two')

    expect(vault.allSecrets()).toEqual({ 'host-1': 'one', 'host-2': 'two' })
  })

  /**
   * The rotation is where a silent failure costs most: a secret dropped here is
   * gone, and gone quietly — nothing throws, the host simply stops working the
   * next time someone opens it, possibly weeks later.
   */
  describe('changing the master password', () => {
    it('carries every secret across', async () => {
      await vault.create(OLD)
      const stored: Record<string, string> = Object.fromEntries(
        Array.from({ length: 20 }, (_, i) => [`host-${i}`, `secret-${i}`])
      )
      // Two that are not plain ASCII, since a re-encryption that mangles the
      // encoding would still round-trip anything in the first 128 characters.
      stored['host-utf8'] = 'пароль-🔐'
      stored['host-long'] = 'x'.repeat(5000)
      for (const [ref, value] of Object.entries(stored)) vault.setSecret(ref, value)

      await vault.changePassword(OLD, NEW)
      vault.lock()
      await vault.unlock(NEW)

      expect(vault.allSecrets()).toEqual(stored)
    })

    it('re-keys rather than only re-writing the verifier', async () => {
      await vault.create(OLD)
      vault.setSecret('host-1', 'hunter2')
      const before = onDisk()

      await vault.changePassword(OLD, NEW)
      const after = onDisk()

      expect(after.salt).not.toBe(before.salt)
      expect(after.verifier).not.toEqual(before.verifier)
      expect(after.secrets['host-1']).not.toEqual(before.secrets['host-1'])
    })

    it('keeps every secret saved while it was working', async () => {
      /*
       * Deriving a key is slow on purpose and runs off the main thread, so the
       * rest of the application keeps going while it does — including anything
       * that saves a password. The re-encryption used to work from a copy of
       * the secrets taken before the second derivation and then write the whole
       * file, so a secret stored during it was overwritten by a file that
       * predated it: lost, silently, with nothing to recover it from.
       *
       * Saved on a timer rather than once, because the window is the *second*
       * derivation and this end cannot see where one ends and the next begins.
       * Whatever the timing, every one of these must survive.
       */
      await vault.create(OLD)
      vault.setSecret('host-0', 'before')

      let saved = 0
      const changing = vault.changePassword(OLD, NEW)
      const ticker = setInterval(() => vault.setSecret(`host-${++saved}`, `during ${saved}`), 10)
      await changing
      clearInterval(ticker)

      expect(saved).toBeGreaterThan(0)
      vault.lock()
      await vault.unlock(NEW)
      const secrets = vault.allSecrets()
      expect(secrets['host-0']).toBe('before')
      for (let i = 1; i <= saved; i++) expect(secrets[`host-${i}`]).toBe(`during ${i}`)
    })

    it('stays closed when it is locked while it works', async () => {
      /*
       * The idle timer can fire mid-change. Finishing anyway put the new key
       * back into an open vault through `adopt`, while the window went on
       * showing its lock screen — the one state worse than either.
       *
       * The lock is aimed at the second derivation by timing the first one: it
       * is the same work with the same parameters, so one is a fair measure of
       * the next. Landing late costs nothing — the assertion is the invariant
       * that matters either way, that an explicit lock leaves the vault closed.
       */
      await vault.create(OLD)
      const started = Date.now()
      vault.lock()
      await vault.unlock(OLD)
      const derivation = Date.now() - started

      const changing = vault.changePassword(OLD, NEW).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, Math.round(derivation * 1.4)))
      vault.lock()
      await changing

      expect(vault.status().unlocked).toBe(false)
    })

    it('runs one change at a time, whatever the caller does', async () => {
      // Two at once would each write the whole file from its own reading of it,
      // and the loser would leave the vault keyed to a password nobody knows.
      await vault.create(OLD)
      vault.setSecret('host-1', 'one')

      const first = vault.changePassword(OLD, NEW)
      const second = vault.changePassword(NEW, 'a third password')
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()

      vault.lock()
      await vault.unlock('a third password')
      expect(vault.getSecret('host-1')).toBe('one')
    })

    it('closes the door on the old password', async () => {
      await vault.create(OLD)
      await vault.changePassword(OLD, NEW)
      vault.lock()

      await expect(vault.unlock(OLD)).rejects.toThrow(WrongPasswordError)
      await vault.unlock(NEW)
      expect(vault.status().unlocked).toBe(true)
    })

    it('leaves everything as it was when the current password is wrong', async () => {
      await vault.create(OLD)
      vault.setSecret('host-1', 'hunter2')
      const before = onDisk()

      await expect(vault.changePassword('not it', NEW)).rejects.toThrow(WrongPasswordError)

      expect(onDisk()).toEqual(before)
      vault.lock()
      await vault.unlock(OLD)
      expect(vault.getSecret('host-1')).toBe('hunter2')
    })
  })

  /**
   * The point of the asynchronous derivation. Were scrypt run synchronously the
   * timer below could not fire until it finished, because nothing else runs at
   * all — which in the app means no terminal draws and no keystroke is
   * forwarded for as long as the vault is opening.
   */
  it('derives off the main thread, so everything else keeps running', async () => {
    await vault.create(OLD)
    vault.lock()

    let ticked = false
    const unlocking = vault.unlock(OLD)
    setImmediate(() => {
      ticked = true
    })
    await unlocking

    expect(ticked).toBe(true)
  })

  /**
   * Every write goes to a temp file and is renamed over the target, so a crash
   * partway through cannot leave a half-written vault. What survives such a
   * crash is a stray `.tmp` — which nothing should ever read.
   */
  it('ignores a temp file left behind by an interrupted write', async () => {
    await vault.create(OLD)
    vault.setSecret('host-1', 'hunter2')
    writeFileSync(`${FILE}.tmp`, '{ "salt": "half a fi', 'utf8')
    vault.lock()

    await vault.unlock(OLD)
    expect(vault.getSecret('host-1')).toBe('hunter2')
  })
})
