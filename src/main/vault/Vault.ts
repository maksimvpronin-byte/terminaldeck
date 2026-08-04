import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
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
    writeFileSync(vaultPath(), JSON.stringify(file, null, 2), 'utf8')
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
    writeFileSync(vaultPath(), JSON.stringify(this.file, null, 2), 'utf8')
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

  deleteSecret(ref: string): void {
    const { file } = this.requireUnlocked()
    delete file.secrets[ref]
    this.persist()
  }
}

export const vault = new Vault()
