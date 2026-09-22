import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A host saved together with the passwords typed for it. The save is made to
 * fail after the vault has already been written, which is where the two used
 * to come apart: the host unchanged, its password changed or gone.
 */

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))
userData = mkdtempSync(join(tmpdir(), 'terminaldeck-secrets-'))

const { vault } = await import('../vault/Vault')
const { forgetSecretsAt, saveWithSecrets, unshareSecrets } = await import('./secrets')

const MASTER = 'correct horse battery staple'
const failingSave = (): never => {
  throw new Error('ENOSPC: no space left on device')
}

beforeEach(async () => {
  vault.lock()
  rmSync(join(userData, 'vault.json'), { force: true })
  await vault.create(MASTER)
  vault.setSecret('host-ref', 'old password')
  vault.setSecret('gateway-ref', 'old gateway password')
})

describe('saving a host with its passwords', () => {
  it('stores them and the host together', () => {
    const host = { id: 'h', secretRef: undefined as string | undefined }
    const saved = saveWithSecrets(host, [['secretRef', 'new password']], (h) => h)

    expect(saved.secretRef).toBeDefined()
    expect(vault.getSecret(saved.secretRef!)).toBe('new password')
  })

  it('keeps the old password when the host fails to save', () => {
    const host = { id: 'h', secretRef: 'host-ref', gatewaySecretRef: 'gateway-ref' }

    expect(() =>
      saveWithSecrets(
        host,
        [
          ['secretRef', 'replacement'],
          ['gatewaySecretRef', 'gateway replacement']
        ],
        failingSave
      )
    ).toThrow(/ENOSPC/)

    expect(vault.getSecret('host-ref')).toBe('old password')
    expect(vault.getSecret('gateway-ref')).toBe('old gateway password')
  })

  it('does not forget a password when forgetting it fails to save', () => {
    const host = { id: 'h', secretRef: 'host-ref' }

    expect(() => saveWithSecrets(host, [['secretRef', null]], failingSave)).toThrow()

    expect(vault.getSecret('host-ref')).toBe('old password')
  })

  it('leaves the vault alone when nothing was typed', () => {
    const write = vi.spyOn(vault, 'changeSecrets')
    saveWithSecrets({ id: 'h', secretRef: 'host-ref' }, [['secretRef', undefined]], (h) => h)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('forgetting the passwords of several hosts', () => {
  it('drops each host’s own and gateway password, and nothing else', () => {
    vault.setSecret('kept-ref', 'someone else’s')

    forgetSecretsAt(
      [{ secretRef: 'host-ref' }, { gatewaySecretRef: 'gateway-ref' }, {}],
      ['secretRef', 'gatewaySecretRef']
    )

    expect(vault.getSecret('host-ref')).toBeUndefined()
    expect(vault.getSecret('gateway-ref')).toBeUndefined()
    expect(vault.getSecret('kept-ref')).toBe('someone else’s')
  })

  it('leaves the vault alone while it is locked', () => {
    vault.lock()
    expect(() => forgetSecretsAt([{ secretRef: 'host-ref' }], ['secretRef'])).not.toThrow()
  })
})

/**
 * A duplicated desktop kept the original's gateway password reference, so the
 * two shared one entry in the vault: deleting either deleted it for both, and
 * a new password typed into one replaced the other's.
 */
describe('a password two hosts point at', () => {
  it('is kept when one of them is deleted', () => {
    forgetSecretsAt(
      [{ gatewaySecretRef: 'gateway-ref' }],
      ['secretRef', 'gatewaySecretRef'],
      new Set(['gateway-ref'])
    )
    expect(vault.getSecret('gateway-ref')).toBe('old gateway password')
  })

  it('is left alone when one of them is given a new one, which goes under a new reference', () => {
    const copy = { id: 'copy', gatewaySecretRef: 'gateway-ref' as string | undefined }
    const saved = saveWithSecrets(
      copy,
      unshareSecrets(copy, [['gatewaySecretRef', 'the copy’s own']], new Set(['gateway-ref'])),
      (h) => h
    )

    expect(saved.gatewaySecretRef).toBeDefined()
    expect(saved.gatewaySecretRef).not.toBe('gateway-ref')
    expect(vault.getSecret(saved.gatewaySecretRef!)).toBe('the copy’s own')
    expect(vault.getSecret('gateway-ref')).toBe('old gateway password')
  })

  it('is left alone when one of them drops it, which only unties that one', () => {
    const copy = { id: 'copy', gatewaySecretRef: 'gateway-ref' as string | undefined }
    const saved = saveWithSecrets(
      copy,
      unshareSecrets(copy, [['gatewaySecretRef', null]], new Set(['gateway-ref'])),
      (h) => h
    )

    expect(saved.gatewaySecretRef).toBeUndefined()
    expect(vault.getSecret('gateway-ref')).toBe('old gateway password')
  })

  it('is changed in place when nothing else points at it', () => {
    const host = { id: 'h', gatewaySecretRef: 'gateway-ref' as string | undefined }
    saveWithSecrets(
      host,
      unshareSecrets(host, [['gatewaySecretRef', 'replacement']], new Set()),
      (h) => h
    )
    expect(host.gatewaySecretRef).toBe('gateway-ref')
    expect(vault.getSecret('gateway-ref')).toBe('replacement')
  })
})
