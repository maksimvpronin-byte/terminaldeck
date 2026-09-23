import { describe, expect, it } from 'vitest'
import { utils, type ParsedKey } from 'ssh2'
import { isPpk, ppkToOpenSsh } from './ppk'
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
