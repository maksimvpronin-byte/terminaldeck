import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'crypto'

const SCRYPT_N = 2 ** 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

export interface EncryptedPayload {
  iv: string
  tag: string
  data: string
}

/**
 * Costly on purpose — that cost is the whole defence against someone working
 * through passwords against a stolen vault file.
 *
 * Which is exactly why it must not be the synchronous form. A few hundred
 * milliseconds of scrypt on the main process is a few hundred milliseconds in
 * which no terminal draws, no keystroke is forwarded and no transfer advances;
 * unlocking the vault froze the whole app, and rotating the password or
 * importing a backup froze it twice. Node runs this on the thread pool instead,
 * and nothing else in the file changes — same parameters, same output, same
 * vault.
 */
export function deriveKey(password: string, saltB64: string): Promise<Buffer> {
  const salt = Buffer.from(saltB64, 'base64')
  const maxmem = 128 * SCRYPT_N * SCRYPT_R * 2
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

/**
 * Overwrites a derived key where it lies.
 *
 * Dropping the last reference to a key leaves it in freed heap memory until
 * something happens to reuse that page — which may be never, and is certainly
 * not before a crash dump or a swapped page could carry it out of the process.
 * Locking the vault is supposed to mean the key is gone, so it is overwritten
 * rather than merely forgotten.
 */
export function wipe(key: Buffer): void {
  key.fill(0)
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
