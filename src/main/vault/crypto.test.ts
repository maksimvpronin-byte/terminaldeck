import { describe, it, expect, beforeAll } from 'vitest'
import { deriveKey, newSalt, encrypt, decrypt, wipe } from './crypto'

describe('vault crypto', () => {
  const salt = newSalt()
  let key: Buffer

  beforeAll(async () => {
    key = await deriveKey('correct horse battery staple', salt)
  })

  it('round-trips a secret', () => {
    const payload = encrypt(key, 'hunter2')
    expect(decrypt(key, payload)).toBe('hunter2')
  })

  it('round-trips non-ASCII and long values', () => {
    const secret = 'пароль-🔐-' + 'x'.repeat(5000)
    expect(decrypt(key, encrypt(key, secret))).toBe(secret)
  })

  it('derives the same key from the same password and salt', async () => {
    expect((await deriveKey('correct horse battery staple', salt)).equals(key)).toBe(true)
  })

  it('derives a different key for a different password', async () => {
    expect((await deriveKey('wrong password', salt)).equals(key)).toBe(false)
  })

  it('derives a different key for a different salt', async () => {
    expect((await deriveKey('correct horse battery staple', newSalt())).equals(key)).toBe(false)
  })

  it('fails to decrypt with the wrong key', async () => {
    const payload = encrypt(key, 'hunter2')
    const wrong = await deriveKey('wrong password', salt)
    expect(() => decrypt(wrong, payload)).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const payload = encrypt(key, 'hunter2')
    const data = Buffer.from(payload.data, 'base64')
    data[0] ^= 0xff
    expect(() => decrypt(key, { ...payload, data: data.toString('base64') })).toThrow()
  })

  it('rejects a tampered auth tag', () => {
    const payload = encrypt(key, 'hunter2')
    const tag = Buffer.from(payload.tag, 'base64')
    tag[0] ^= 0xff
    expect(() => decrypt(key, { ...payload, tag: tag.toString('base64') })).toThrow()
  })

  it('uses a fresh IV per encryption, so equal plaintexts differ', () => {
    const a = encrypt(key, 'same')
    const b = encrypt(key, 'same')
    expect(a.iv).not.toBe(b.iv)
    expect(a.data).not.toBe(b.data)
  })

  it('generates distinct salts', () => {
    expect(newSalt()).not.toBe(newSalt())
  })

  it('leaves nothing behind when a key is wiped', async () => {
    const doomed = await deriveKey('correct horse battery staple', salt)
    expect(doomed.some((byte) => byte !== 0)).toBe(true)

    wipe(doomed)

    expect(doomed.every((byte) => byte === 0)).toBe(true)
  })
})
