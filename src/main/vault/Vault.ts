import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { deriveKey, newSalt, encrypt, decrypt, wipe, type EncryptedPayload } from './crypto'
import { MIN_MASTER_PASSWORD_LENGTH, type VaultStatus } from '../../shared/types'

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

/** Also what `vault/locked.ts` refuses with, so there is one error for one state. */
export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock TerminalDeck to continue.')
    this.name = 'VaultLockedError'
  }
}

/**
 * The renderer checks the length before it asks, but the renderer is not where
 * the vault is. Checked again here, where the password is actually used.
 */
function requireAcceptablePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(`Master password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters`)
  }
}

class Vault {
  private key: Buffer | null = null
  private file: VaultFile | null = null

  status(): VaultStatus {
    return { exists: existsSync(vaultPath()), unlocked: this.isUnlocked() }
  }

  /** Whether it is open, without asking the disk whether it exists. */
  isUnlocked(): boolean {
    return this.key !== null
  }

  /**
   * Makes a new, empty vault — and only where there is none.
   *
   * It used to write over whatever was there. The renderer only offers it when
   * `status` says there is no vault, but a request that says "create" is not
   * proof of that: a second window, a stale screen, or a renderer that is not
   * behaving would replace every stored credential with an empty file, and the
   * old one is not kept anywhere.
   */
  async create(password: string): Promise<void> {
    return this.serially(async (started) => {
      requireAcceptablePassword(password)
      if (existsSync(vaultPath())) throw new Error('A vault already exists')
      const salt = newSalt()
      const key = await deriveKey(password, salt)
      if (this.generation !== started || existsSync(vaultPath())) {
        wipe(key)
        throw new Error('The vault changed while it was being created')
      }
      const verifier = encrypt(key, VERIFIER_PLAINTEXT)
      const file: VaultFile = { salt, verifier, secrets: {} }
      writeVaultFile(file)
      this.adopt(file, key)
    })
  }

  /**
   * Opens the vault — unless it was locked while the key was being derived.
   *
   * The derivation is long and off the main thread, so a lock can arrive in the
   * middle of it: the idle timer, the lock button, the window going away.
   * Finishing anyway put the key back, and the vault was open again behind a
   * lock that everyone else had already been told about.
   */
  async unlock(password: string): Promise<void> {
    return this.serially(async (started) => {
      const raw = readFileSync(vaultPath(), 'utf8')
      const file = JSON.parse(raw) as VaultFile
      const key = await deriveKey(password, file.salt)
      if (this.generation !== started) {
        wipe(key)
        throw new VaultLockedError()
      }
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
    })
  }

  /** Takes on a key, overwriting whichever one it replaces. */
  private adopt(file: VaultFile, key: Buffer): void {
    if (this.key) wipe(this.key)
    this.file = file
    this.key = key
  }

  /**
   * Closes the vault, and makes stale every key still being derived.
   *
   * Synchronous and never queued: a lock takes effect the moment it is asked
   * for, not after an unlock that is still working has finished.
   */
  lock(): void {
    this.generation++
    if (this.key) wipe(this.key)
    this.key = null
    this.file = null
  }

  /**
   * Re-keys the vault: every secret is decrypted with the old key and re-encrypted
   * under a key derived from the new password and a fresh salt.
   *
   * Two derivations, and therefore two moments where the rest of the
   * application runs: scrypt is deliberately slow and deliberately off the main
   * thread, so anything else can happen in between. Both moments are guarded,
   * and the second one used not to be —
   *
   * - the idle timer can lock the vault, and finishing afterwards put the key
   *   back through `adopt`. The window kept its lock screen up while the main
   *   process was open again: the worst of both, since the person looking at it
   *   believed it was closed.
   * - a secret can be saved, by a host dialog or by a sync storing a
   *   credential. The re-encryption worked from a snapshot taken before the
   *   wait and then wrote the whole file, so that secret was gone — silently,
   *   and with nothing left to recover it from.
   *
   * Hence: one change of password at a time, the state re-checked after every
   * wait, and the secrets read at the moment they are re-encrypted rather than
   * before the wait that precedes it.
   */
  async changePassword(current: string, next: string): Promise<void> {
    return this.serially((started) => this.rekey(current, next, started))
  }

  /**
   * Every operation that waits on a key derivation, one at a time.
   *
   * Two of them at once would each work from their own reading of the vault,
   * and the second would undo the first — two changes of password leaving it
   * keyed to one nobody was told about, or an unlock adopting a file that a
   * create had just replaced.
   */
  private queue: Promise<void> = Promise.resolve()

  /**
   * The generation is read when the operation is asked for, not when its turn
   * comes: a lock that arrives while it is still waiting in line overtakes it
   * just the same.
   */
  private serially(operation: (started: number) => Promise<void>): Promise<void> {
    const started = this.generation
    const go = (): Promise<void> => operation(started)
    const run = this.queue.then(go, go)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Moved by every lock. An operation that sees it move has been overtaken. */
  private generation = 0

  private async rekey(current: string, next: string, started: number): Promise<void> {
    requireAcceptablePassword(next)
    if (this.generation !== started) throw new VaultLockedError()
    const { key: oldKey, file } = this.requireUnlocked()
    const check = await deriveKey(current, file.salt)
    // Deriving a key takes long enough for the idle timer to lock the vault
    // underneath this. Checked before the comparison rather than after: locking
    // overwrites the key being compared against, so the comparison would fail
    // and report a wrong password for what is really a closed vault.
    if (this.generation !== started || this.key !== oldKey) {
      wipe(check)
      throw new VaultLockedError()
    }
    const matches = check.equals(oldKey)
    wipe(check)
    if (!matches) throw new WrongPasswordError()

    const salt = newSalt()
    const key = await deriveKey(next, salt)
    /*
     * The same check as above, for the same reason: this wait is the longer of
     * the two, and adopting a key into a vault that has since been locked would
     * open it again behind the lock screen.
     */
    const live = this.file
    if (this.generation !== started || this.key !== oldKey || !live) {
      wipe(key)
      throw new VaultLockedError()
    }

    /*
     * Read here, after the last wait, and not one statement earlier. Everything
     * from this line to the write is synchronous, so what is re-encrypted is
     * what the vault holds at the moment it is written — a secret saved while
     * the key was being derived is carried across rather than overwritten by a
     * copy of the file taken before it existed. `live`, not `file`: saving a
     * secret replaces the file object rather than changing the old one.
     */
    const secrets: Record<string, EncryptedPayload> = {}
    for (const [ref, payload] of Object.entries(live.secrets)) {
      secrets[ref] = encrypt(key, decrypt(oldKey, payload))
    }

    const rekeyed: VaultFile = { salt, verifier: encrypt(key, VERIFIER_PLAINTEXT), secrets }
    // Only adopt the new key once the file is safely on disk. Adopting it also
    // overwrites the old one, which has nothing left to open.
    writeVaultFile(rekeyed)
    this.adopt(rekeyed, key)
  }

  private requireUnlocked(): { key: Buffer; file: VaultFile } {
    if (!this.key || !this.file) throw new VaultLockedError()
    return { key: this.key, file: this.file }
  }

  /**
   * Stores a secret — on disk first, and only then in memory.
   *
   * Changed in place and then written, a failed write left the secret in the
   * open vault anyway: the host said its password was saved, it worked until
   * the next restart, and then it was gone, long after the error had been
   * dismissed.
   */
  setSecret(ref: string, plaintext: string): void {
    this.setSecrets({ [ref]: plaintext })
  }

  /** Several at once, in one write, for an import. */
  setSecrets(values: Record<string, string>): void {
    const { key, file } = this.requireUnlocked()
    const secrets = { ...file.secrets }
    for (const [ref, plaintext] of Object.entries(values)) secrets[ref] = encrypt(key, plaintext)
    this.replaceFile({ ...file, secrets })
  }

  /** Writes a changed file and adopts it only once it is on disk. */
  private replaceFile(next: VaultFile): void {
    writeVaultFile(next)
    this.file = next
  }

  /** The stored ciphertexts as they stand, for putting back after a failed import. */
  snapshotSecrets(): Record<string, EncryptedPayload> {
    return this.requireUnlocked().file.secrets
  }

  restoreSecrets(previous: Record<string, EncryptedPayload>): void {
    const { file } = this.requireUnlocked()
    this.replaceFile({ ...file, secrets: previous })
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
    if (!(ref in file.secrets)) return
    const secrets = { ...file.secrets }
    delete secrets[ref]
    this.replaceFile({ ...file, secrets })
  }
}

export const vault = new Vault()
