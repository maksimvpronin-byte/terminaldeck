import { describe, expect, it } from 'vitest'
import { utils, type ParsedKey } from 'ssh2'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isPpk, ppkToOpenSsh, readPrivateKey } from './ppk'
import { FIXTURES } from './ppk.fixtures'

function publicBlobOf(ppk: string): Buffer {
  const lines = ppk.split('\n')
  const at = lines.findIndex((l) => l.startsWith('Public-Lines:'))
  const count = Number(lines[at].split(':')[1])
  return Buffer.from(lines.slice(at + 1, at + 1 + count).join(''), 'base64')
}

function parsed(pem: string): ParsedKey {
  const key = utils.parseKey(pem)
  if (key instanceof Error) throw key
  return Array.isArray(key) ? key[0] : key
}

/**
 * Every fixture is a file PuTTYgen wrote. What comes out has to be something
 * ssh2 reads, whose public half is the one PuTTY recorded, and which can sign —
 * a private half that did not belong to that public key would fail to verify.
 */
describe('PuTTY key files', () => {
  for (const fixture of FIXTURES) {
    const header = fixture.text.split('\n')[0]
    const encrypted = fixture.passphrase ? ', encrypted' : ''
    it(`converts ${header}${encrypted}`, { timeout: 60_000 }, async () => {
      const key = parsed(await ppkToOpenSsh(fixture.text, fixture.passphrase))
      expect(key.type).toBe(header.split(': ')[1])
      expect(key.getPublicSSH()).toEqual(publicBlobOf(fixture.text))
      const data = Buffer.from('terminaldeck')
      expect(key.verify(data, key.sign(data))).toBe(true)
    })
  }

  const encrypted = FIXTURES.find(
    (f) => f.text.startsWith('PuTTY-User-Key-File-2: ssh-ed25519') && f.passphrase
  )!
  const plain = FIXTURES.find((f) => f.text.includes('Encryption: none'))!

  it('knows one when it sees one', () => {
    expect(isPpk(Buffer.from(plain.text))).toBe(true)
    expect(isPpk(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\n'))).toBe(false)
  })

  it('says so when the passphrase is wrong', async () => {
    await expect(ppkToOpenSsh(encrypted.text, 'not it')).rejects.toThrow('Wrong passphrase')
  })

  it('says so when there is no passphrase for an encrypted file', async () => {
    await expect(ppkToOpenSsh(encrypted.text)).rejects.toThrow('no passphrase given')
  })

  it('ignores a passphrase an unencrypted file does not need', async () => {
    expect(parsed(await ppkToOpenSsh(plain.text, 'stray'))).toBeTruthy()
  })

  it('refuses a file that has been altered', async () => {
    const altered = plain.text.replace('Comment: ', 'Comment: x')
    await expect(ppkToOpenSsh(altered)).rejects.toThrow('corrupt')
  })

  it('refuses the SSH-1 era format by name', async () => {
    await expect(ppkToOpenSsh(plain.text.replace(/File-\d/, 'File-1'))).rejects.toThrow('version 1')
  })
})

/**
 * A line count is the file's to state, and a damaged one is a damaged file.
 * -1 stepped the parser back onto the same line for ever, synchronously, in
 * the main process: every window and connection stopped with it.
 */
describe('a damaged PuTTY key file', () => {
  it('is refused when it states a line count it cannot have', async () => {
    for (const count of ['-1', '1.5', '999']) {
      const text = `PuTTY-User-Key-File-3: ssh-ed25519\nPublic-Lines: ${count}\nAAAA\n`
      await expect(ppkToOpenSsh(text, undefined)).rejects.toThrow(/line count/i)
    }
  })
})

/**
 * An inventory states its key files as Ansible takes them, and Ansible opens
 * `~/.ssh/id_ed25519` in the home folder. It was read as a relative path.
 */
describe('a key file under the home folder', () => {
  it('is read through a leading ~', async () => {
    const home = mkdtempSync(join(tmpdir(), 'td-home-'))
    // homedir() reads HOME on macOS and Linux, USERPROFILE on Windows.
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      mkdirSync(join(home, '.ssh'))
      writeFileSync(join(home, '.ssh', 'id_test'), 'not a ppk')
      const { privateKey } = await readPrivateKey('~/.ssh/id_test', undefined)
      expect(privateKey.toString()).toBe('not a ppk')
    } finally {
      for (const [name, value] of Object.entries(before)) {
        // Assigned undefined, an environment variable becomes "undefined".
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  })
})
