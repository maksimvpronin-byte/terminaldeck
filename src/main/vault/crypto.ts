import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'crypto'

const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

export interface EncryptedPayload {
  iv: string
  tag: string
  data: string
}

export function deriveKey(password: string, saltB64: string): Buffer {
  const salt = Buffer.from(saltB64, 'base64')
  const maxmem = 128 * SCRYPT_N * SCRYPT_R * 2
  return scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem })
}

export function newSalt(): string {
  return randomBytes(16).toString('base64')
}

export function encrypt(key: Buffer, plaintext: string): EncryptedPayload {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') }
}

export function decrypt(key: Buffer, payload: EncryptedPayload): string {
  const iv = Buffer.from(payload.iv, 'base64')
  const tag = Buffer.from(payload.tag, 'base64')
  const data = Buffer.from(payload.data, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}
