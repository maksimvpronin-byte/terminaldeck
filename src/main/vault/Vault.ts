import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { deriveKey, newSalt, encrypt, decrypt, type EncryptedPayload } from './crypto'
import type { VaultStatus } from '../../shared/types'

const VERIFIER_PLAINTEXT = 'terminaldeck-vault-v1'

interface VaultFile {
  salt: string
  verifier: EncryptedPayload
  secrets: Record<string, EncryptedPayload>
}

function vaultPath(): string {
  return join(app.getPath('userData'), 'vault.json')
}

/**
 * Writes via a temp file and rename. A crash partway through a direct write would
 * leave a truncated vault, losing every stored credential.
 */
function writeVaultFile(file: VaultFile): void {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const target = vaultPath()
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, target)
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect master password')
    this.name = 'WrongPasswordError'
  }
}

class Vault {
  private key: Buffer | null = null
  private file: VaultFile | null = null

  status(): VaultStatus {
    return { exists: existsSync(vaultPath()), unlocked: this.key !== null }
  }

  create(password: string): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const salt = newSalt()
    const key = deriveKey(password, salt)
    const verifier = encrypt(key, VERIFIER_PLAINTEXT)
    const file: VaultFile = { salt, verifier, secrets: {} }
    writeVaultFile(file)
    this.file = file
    this.key = key
  }

  unlock(password: string): void {
    const raw = readFileSync(vaultPath(), 'utf8')
    const file = JSON.parse(raw) as VaultFile
    const key = deriveKey(password, file.salt)
    try {
      const plain = decrypt(key, file.verifier)
      if (plain !== VERIFIER_PLAINTEXT) throw new Error('mismatch')
    } catch {
      throw new WrongPasswordError()
    }
    this.file = file
    this.key = key
  }

  lock(): void {
    this.key = null
    this.file = null
  }

  private persist(): void {
    if (!this.file) return
    writeVaultFile(this.file)
  }

  /**
   * Re-keys the vault: every secret is decrypted with the old key and re-encrypted
   * under a key derived from the new password and a fresh salt.
   */
  changePassword(current: string, next: string): void {
    const { key: oldKey, file } = this.requireUnlocked()
    if (!deriveKey(current, file.salt).equals(oldKey)) throw new WrongPasswordError()

    const plaintexts = new Map<string, string>()
    for (const [ref, payload] of Object.entries(file.secrets)) {
      plaintexts.set(ref, decrypt(oldKey, payload))
    }

    const salt = newSalt()
    const key = deriveKey(next, salt)
    const secrets: Record<string, EncryptedPayload> = {}
    for (const [ref, value] of plaintexts) secrets[ref] = encrypt(key, value)

    const rekeyed: VaultFile = { salt, verifier: encrypt(key, VERIFIER_PLAINTEXT), secrets }
    // Only adopt the new key once the file is safely on disk.
    writeVaultFile(rekeyed)
    this.file = rekeyed
    this.key = key
  }

  private requireUnlocked(): { key: Buffer; file: VaultFile } {
    if (!this.key || !this.file) throw new Error('Vault is locked')
    return { key: this.key, file: this.file }
  }

  setSecret(ref: string, plaintext: string): void {
    const { key, file } = this.requireUnlocked()
    file.secrets[ref] = encrypt(key, plaintext)
    this.persist()
  }

  getSecret(ref: string): string | undefined {
    const { key, file } = this.requireUnlocked()
    const payload = file.secrets[ref]
    if (!payload) return undefined
    return decrypt(key, payload)
  }

  /**
   * Every stored secret in the clear. Only for export, which re-encrypts them
   * under a password of the user's choosing before anything reaches disk.
   */
  allSecrets(): Record<string, string> {
    const { key, file } = this.requireUnlocked()
    const out: Record<string, string> = {}
    for (const [ref, payload] of Object.entries(file.secrets)) out[ref] = decrypt(key, payload)
    return out
  }

  deleteSecret(ref: string): void {
    const { file } = this.requireUnlocked()
    delete file.secrets[ref]
    this.persist()
  }
}

export const vault = new Vault()
