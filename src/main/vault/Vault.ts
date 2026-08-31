import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { deriveKey, newSalt, encrypt, decrypt, wipe, type EncryptedPayload } from './crypto'
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

  async create(password: string): Promise<void> {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const salt = newSalt()
    const key = await deriveKey(password, salt)
    const verifier = encrypt(key, VERIFIER_PLAINTEXT)
    const file: VaultFile = { salt, verifier, secrets: {} }
    writeVaultFile(file)
    this.adopt(file, key)
  }

  async unlock(password: string): Promise<void> {
    const raw = readFileSync(vaultPath(), 'utf8')
    const file = JSON.parse(raw) as VaultFile
    const key = await deriveKey(password, file.salt)
    try {
      const plain = decrypt(key, file.verifier)
      if (plain !== VERIFIER_PLAINTEXT) throw new Error('mismatch')
    } catch {
      // This key never becomes the vault's, so it is overwritten here rather
      // than left lying in the heap for whoever guesses next.
      wipe(key)
      throw new WrongPasswordError()
    }
    this.adopt(file, key)
  }

  /** Takes on a key, overwriting whichever one it replaces. */
  private adopt(file: VaultFile, key: Buffer): void {
    if (this.key) wipe(this.key)
    this.file = file
    this.key = key
  }

  lock(): void {
    if (this.key) wipe(this.key)
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
  async changePassword(current: string, next: string): Promise<void> {
    const { key: oldKey, file } = this.requireUnlocked()
    const check = await deriveKey(current, file.salt)
    // Deriving a key takes long enough for the idle timer to lock the vault
    // underneath this. Checked before the comparison rather than after: locking
    // overwrites the key being compared against, so the comparison would fail
    // and report a wrong password for what is really a closed vault.
    if (this.key !== oldKey) {
      wipe(check)
      throw new Error('Vault is locked')
    }
    const matches = check.equals(oldKey)
    wipe(check)
    if (!matches) throw new WrongPasswordError()

    const plaintexts = new Map<string, string>()
    for (const [ref, payload] of Object.entries(file.secrets)) {
      plaintexts.set(ref, decrypt(oldKey, payload))
    }

    const salt = newSalt()
    const key = await deriveKey(next, salt)
    const secrets: Record<string, EncryptedPayload> = {}
    for (const [ref, value] of plaintexts) secrets[ref] = encrypt(key, value)

    const rekeyed: VaultFile = { salt, verifier: encrypt(key, VERIFIER_PLAINTEXT), secrets }
    // Only adopt the new key once the file is safely on disk. Adopting it also
    // overwrites the old one, which has nothing left to open.
    writeVaultFile(rekeyed)
    this.adopt(rekeyed, key)
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
