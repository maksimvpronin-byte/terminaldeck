import { dialog, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { deriveKey, newSalt, encrypt, decrypt, wipe, type EncryptedPayload } from '../vault/crypto'
import { vault } from '../vault/Vault'
import { sessionStore } from './SessionStore'
import { snippetStore } from './SnippetStore'
import { collectionStore } from './CollectionStore'
import { credentialStore } from './CredentialStore'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import type {
  Credential,
  ImportSummary,
  InventoryOverride,
  InventorySource,
  SessionGroup,
  SessionProfile,
  Snippet,
  HostCollection
} from '../../shared/types'

interface BackupFile {
  format: 'terminaldeck-backup'
  version: 1
  exportedAt: number
  groups: SessionGroup[]
  sessions: SessionProfile[]
  snippets: Snippet[]
  collections: HostCollection[]
  inventorySources: InventorySource[]
  inventoryOverrides: InventoryOverride[]
  /**
   * Local settings for hosts a Sessions folder mirrors out of git. The folder
   * itself, its repository and the groups chosen from it travel in `groups` —
   * they are part of the folder. The mirrored tree does not: it is a copy of
   * something the repository still has, and one sync on the new machine is
   * cheaper than carrying a stale one around.
   */
  gitFolderOverrides?: InventoryOverride[]
  /**
   * Logins saved on their own. Absent from a file written before they existed,
   * which is why every reader here treats the list as optional.
   */
  credentials?: Credential[]
  /** Present only when secrets were included; encrypted under its own password. */
  secrets?: { salt: string; payload: EncryptedPayload }
}

type UnknownRecord = Record<string, unknown>

function invalid(path: string): never {
  throw new Error(`Invalid TerminalDeck export: ${path}`)
}

function asRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${path} must be an object`)
  }
  return value as UnknownRecord
}

function requiredString(record: UnknownRecord, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string') return invalid(`${path}.${key} must be a string`)
  return value
}

function optionalString(record: UnknownRecord, key: string, path: string): void {
  const value = record[key]
  if (value !== undefined && typeof value !== 'string') {
    invalid(`${path}.${key} must be a string`)
  }
}

function requiredNumber(record: UnknownRecord, key: string, path: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(`${path}.${key} must be a finite number`)
  }
  return value
}

function optionalNumber(record: UnknownRecord, key: string, path: string): void {
  const value = record[key]
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    invalid(`${path}.${key} must be a finite number`)
  }
}

function requiredBoolean(record: UnknownRecord, key: string, path: string): void {
  if (typeof record[key] !== 'boolean') invalid(`${path}.${key} must be a boolean`)
}

function optionalBoolean(record: UnknownRecord, key: string, path: string): void {
  const value = record[key]
  if (value !== undefined && typeof value !== 'boolean') {
    invalid(`${path}.${key} must be a boolean`)
  }
}

function requiredNullableString(record: UnknownRecord, key: string, path: string): void {
  const value = record[key]
  if (value !== null && typeof value !== 'string') {
    invalid(`${path}.${key} must be a string or null`)
  }
}

function optionalNullableString(record: UnknownRecord, key: string, path: string): void {
  const value = record[key]
  if (value !== undefined && value !== null && typeof value !== 'string') {
    invalid(`${path}.${key} must be a string or null`)
  }
}

function enumField(
  record: UnknownRecord,
  key: string,
  path: string,
  allowed: readonly string[],
  required = false
): void {
  const value = record[key]
  if (value === undefined && !required) return
  if (typeof value !== 'string' || !allowed.includes(value)) {
    invalid(`${path}.${key} has an unsupported value`)
  }
}

function validatedArray<T>(
  value: unknown,
  path: string,
  validate: (item: unknown, itemPath: string) => T
): T[] {
  if (!Array.isArray(value)) return invalid(`${path} must be an array`)
  return value.map((item, index) => validate(item, `${path}[${index}]`))
}

function stringArray(value: unknown, path: string): string[] {
  return validatedArray(value, path, (item, itemPath) => {
    if (typeof item !== 'string') return invalid(`${itemPath} must be a string`)
    return item
  })
}

function optionalStringArray(record: UnknownRecord, key: string, path: string): void {
  if (record[key] !== undefined) stringArray(record[key], `${path}.${key}`)
}

function validateDefaults(record: UnknownRecord, path: string): void {
  if (record.fileAccess !== undefined) {
    const access = asRecord(record.fileAccess, `${path}.fileAccess`)
    enumField(access, 'protocol', `${path}.fileAccess`, ['sftp', 'scp'], true)
    optionalString(access, 'shell', `${path}.fileAccess`)
  }
  for (const key of [
    'username',
    'privateKeyPath',
    'secretRef',
    'onConnectCommand',
    'gatewayHost',
    'gatewayUsername',
    'gatewaySecretRef',
    'fontFamily',
    'themeName'
  ]) {
    optionalString(record, key, path)
  }
  for (const key of [
    'port',
    'gatewayPort',
    'desktopWidth',
    'desktopHeight',
    'pixelBudget',
    'magnification',
    'fontSize',
    'scrollback'
  ]) {
    optionalNumber(record, key, path)
  }
  for (const key of [
    'inheritAuth',
    'agentForward',
    'followTerminalCwd',
    'inheritRdp',
    'gatewayBypassLocal',
    'sound',
    'sendDensity',
    'commandAsControl',
    'inheritAppearance',
    'cursorBlink'
  ]) {
    optionalBoolean(record, key, path)
  }
  optionalNullableString(record, 'jumpHostId', path)
  enumField(record, 'authMethod', path, ['password', 'privateKey', 'agent'])
  enumField(record, 'resolution', path, ['fit', 'fixed'])
  enumField(record, 'cursorStyle', path, ['block', 'underline', 'bar'])
}

function validateGitFolderLink(value: unknown, path: string): void {
  const record = asRecord(value, path)
  requiredString(record, 'repoUrl', path)
  optionalString(record, 'branch', path)
  stringArray(record.paths, `${path}.paths`)
  stringArray(record.includedGroups, `${path}.includedGroups`)
  optionalStringArray(record, 'knownGroups', path)
  optionalStringArray(record, 'lastFiles', path)
  optionalNumber(record, 'lastSyncedAt', path)
  optionalString(record, 'lastRevision', path)
  optionalString(record, 'lastError', path)
}

function validatePortForward(value: unknown, path: string): void {
  const record = asRecord(value, path)
  requiredString(record, 'id', path)
  enumField(record, 'type', path, ['local', 'remote', 'dynamic'], true)
  requiredString(record, 'srcHost', path)
  requiredNumber(record, 'srcPort', path)
  optionalString(record, 'dstHost', path)
  optionalNumber(record, 'dstPort', path)
}

function validateSessionGroup(value: unknown, path: string): SessionGroup {
  const record = asRecord(value, path)
  const id = requiredString(record, 'id', path)
  if (id.length === 0 || id.length > 128 || id === '.' || id === '..' || /[\\/\0]/.test(id)) {
    invalid(`${path}.id is not a safe identifier`)
  }
  requiredString(record, 'name', path)
  requiredNullableString(record, 'parentId', path)
  validateDefaults(record, path)
  if (record.git !== undefined) validateGitFolderLink(record.git, `${path}.git`)
  return record as unknown as SessionGroup
}

function validateSessionProfile(value: unknown, path: string): SessionProfile {
  const record = asRecord(value, path)
  requiredString(record, 'id', path)
  requiredString(record, 'name', path)
  requiredString(record, 'host', path)
  requiredNullableString(record, 'groupId', path)
  stringArray(record.tags, `${path}.tags`)
  requiredBoolean(record, 'logToFile', path)
  validatedArray(record.portForwards, `${path}.portForwards`, (item, itemPath) => {
    validatePortForward(item, itemPath)
    return item
  })
  requiredNumber(record, 'createdAt', path)
  requiredNumber(record, 'updatedAt', path)
  optionalString(record, 'color', path)
  enumField(record, 'protocol', path, ['ssh', 'rdp'])
  validateDefaults(record, path)
  return record as unknown as SessionProfile
}

function validateInventorySource(value: unknown, path: string): InventorySource {
  const record = asRecord(value, path)
  const id = requiredString(record, 'id', path)
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) invalid(`${path}.id is not a safe identifier`)
  requiredString(record, 'name', path)
  requiredString(record, 'repoUrl', path)
  stringArray(record.paths, `${path}.paths`)
  optionalString(record, 'branch', path)
  optionalString(record, 'color', path)
  optionalNumber(record, 'lastSyncedAt', path)
  optionalString(record, 'lastRevision', path)
  optionalString(record, 'lastError', path)
  optionalStringArray(record, 'lastFiles', path)
  validateDefaults(record, path)
  return record as unknown as InventorySource
}

function validateInventoryOverride(value: unknown, path: string): InventoryOverride {
  const record = asRecord(value, path)
  requiredString(record, 'nodeId', path)
  optionalString(record, 'color', path)
  validateDefaults(record, path)
  return record as unknown as InventoryOverride
}

function validateCredential(value: unknown, path: string): Credential {
  const record = asRecord(value, path)
  requiredString(record, 'id', path)
  requiredString(record, 'name', path)
  requiredString(record, 'username', path)
  enumField(record, 'authMethod', path, ['password', 'privateKey', 'agent'], true)
  optionalString(record, 'privateKeyPath', path)
  optionalString(record, 'secretRef', path)
  requiredNumber(record, 'createdAt', path)
  requiredNumber(record, 'updatedAt', path)
  return record as unknown as Credential
}

function validateSnippet(value: unknown, path: string): Snippet {
  const record = asRecord(value, path)
  requiredString(record, 'id', path)
  requiredString(record, 'name', path)
  requiredString(record, 'command', path)
  stringArray(record.tags, `${path}.tags`)
  requiredNumber(record, 'createdAt', path)
  requiredNumber(record, 'updatedAt', path)
  return record as unknown as Snippet
}

function validateCollection(value: unknown, path: string): HostCollection {
  const record = asRecord(value, path)
  requiredString(record, 'id', path)
  requiredString(record, 'name', path)
  stringArray(record.hostIds, `${path}.hostIds`)
  requiredNumber(record, 'createdAt', path)
  requiredNumber(record, 'updatedAt', path)
  optionalString(record, 'color', path)
  validateDefaults(record, path)
  return record as unknown as HostCollection
}

function validateEncryptedPayload(value: unknown, path: string): EncryptedPayload {
  const record = asRecord(value, path)
  return {
    iv: requiredString(record, 'iv', path),
    tag: requiredString(record, 'tag', path),
    data: requiredString(record, 'data', path)
  }
}

function validateBackupFile(value: unknown): BackupFile {
  const record = asRecord(value, 'backup')
  if (record.format !== 'terminaldeck-backup') {
    return invalid('backup.format is not terminaldeck-backup')
  }
  if (record.version !== 1) return invalid('backup.version is unsupported')

  let secrets: BackupFile['secrets']
  if (record.secrets !== undefined) {
    const envelope = asRecord(record.secrets, 'backup.secrets')
    secrets = {
      salt: requiredString(envelope, 'salt', 'backup.secrets'),
      payload: validateEncryptedPayload(envelope.payload, 'backup.secrets.payload')
    }
  }

  return {
    format: 'terminaldeck-backup',
    version: 1,
    exportedAt: requiredNumber(record, 'exportedAt', 'backup'),
    groups: validatedArray(record.groups, 'backup.groups', validateSessionGroup),
    sessions: validatedArray(record.sessions, 'backup.sessions', validateSessionProfile),
    snippets: validatedArray(record.snippets, 'backup.snippets', validateSnippet),
    collections: validatedArray(record.collections, 'backup.collections', validateCollection),
    inventorySources: validatedArray(
      record.inventorySources,
      'backup.inventorySources',
      validateInventorySource
    ),
    inventoryOverrides: validatedArray(
      record.inventoryOverrides,
      'backup.inventoryOverrides',
      validateInventoryOverride
    ),
    gitFolderOverrides:
      record.gitFolderOverrides === undefined
        ? undefined
        : validatedArray(
            record.gitFolderOverrides,
            'backup.gitFolderOverrides',
            validateInventoryOverride
          ),
    credentials:
      record.credentials === undefined
        ? undefined
        : validatedArray(record.credentials, 'backup.credentials', validateCredential),
    secrets
  }
}

function validateSecretMap(value: unknown): Record<string, string> {
  const record = asRecord(value, 'credentials payload')
  const out = Object.create(null) as Record<string, string>
  for (const [ref, secret] of Object.entries(record)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref)) invalid('credentials payload contains an invalid id')
    if (typeof secret !== 'string') invalid(`credentials payload.${ref} must be a string`)
    out[ref] = secret
  }
  return out
}

/**
 * Writes everything but the terminal look-and-feel to one file. Credentials are
 * optional and, when included, are re-encrypted under a password given here —
 * they are never written in the clear, and the master password is not reused so
 * the file can be shared with a different machine without handing over the vault.
 */
export async function exportToFile(
  win: BrowserWindow,
  includeSecrets: boolean,
  password?: string
): Promise<string | undefined> {
  if (includeSecrets && !password) throw new Error('A password is required to export credentials')

  const store = sessionStore.getAll()
  const backup: BackupFile = {
    format: 'terminaldeck-backup',
    version: 1,
    exportedAt: Date.now(),
    groups: store.groups,
    sessions: store.sessions,
    snippets: snippetStore.list(),
    collections: collectionStore.list(),
    inventorySources: inventoryStore.sources(),
    inventoryOverrides: inventoryStore.overrides(),
    gitFolderOverrides: gitFolderStore.overrides(),
    credentials: credentialStore.list()
  }

  if (includeSecrets && password) {
    // Only secrets something in this export actually points at. The vault can
    // hold orphans from deleted sessions, and there is no reason to carry those
    // out of the machine.
    const wanted = new Set(
      [
        ...backup.groups,
        ...backup.sessions,
        ...backup.inventorySources,
        ...backup.inventoryOverrides,
        ...(backup.gitFolderOverrides ?? []),
        ...(backup.credentials ?? [])
      ]
        /*
         * Both refs, not one. A gateway keeps its password under
         * `gatewaySecretRef` — a separate entry in the vault, because the login
         * a gateway takes is regularly not the one the host does — and only
         * `secretRef` was collected here. The export then carried the field and
         * not the secret it points at, so a restored host said "saved on this
         * host" about a password the vault had never heard of: not merely lost,
         * but lost while claiming otherwise, which is the version nobody goes
         * looking for until the gateway refuses them.
         */
        .flatMap((item) => [
          item.secretRef,
          (item as { gatewaySecretRef?: string }).gatewaySecretRef
        ])
        .filter((ref): ref is string => Boolean(ref))
    )
    const all = vault.allSecrets()
    const referenced = Object.fromEntries(Object.entries(all).filter(([ref]) => wanted.has(ref)))

    const salt = newSalt()
    const key = await deriveKey(password, salt)
    backup.secrets = { salt, payload: encrypt(key, JSON.stringify(referenced)) }
    // This key exists for one encryption and has no business outliving it.
    wipe(key)
  }

  const res = await dialog.showSaveDialog(win, {
    title: 'Export TerminalDeck data',
    defaultPath: `terminaldeck-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || !res.filePath) return undefined

  writeFileSync(res.filePath, JSON.stringify(backup, null, 2), 'utf8')
  return res.filePath
}

/** Merges a backup in by id: existing entries are replaced, nothing is deleted. */
export async function importFromFile(
  win: BrowserWindow,
  password?: string
): Promise<ImportSummary | undefined> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import TerminalDeck data',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return undefined
  const parsed = validateBackupFile(JSON.parse(readFileSync(res.filePaths[0], 'utf8')) as unknown)

  const summary: ImportSummary = {
    groups: 0,
    sessions: 0,
    snippets: 0,
    collections: 0,
    inventorySources: 0,
    inventoryOverrides: 0,
    gitFolderOverrides: 0,
    credentials: 0,
    secrets: 0
  }

  // Secrets first: a session is useless if its credential lands later and fails.
  if (parsed.secrets) {
    if (!password) throw new Error('This export contains credentials and needs its password')
    // Derived outside the try: deriving cannot fail for a wrong password, and
    // reporting an out-of-memory as "wrong password" would send someone hunting
    // for a password that was right all along.
    const key = await deriveKey(password, parsed.secrets.salt)
    let decrypted: string
    try {
      decrypted = decrypt(key, parsed.secrets.payload)
    } catch {
      throw new Error('Wrong password for the credentials in this export')
    } finally {
      wipe(key)
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(decrypted) as unknown
    } catch {
      throw new Error('The credentials payload in this export is invalid')
    }
    const secrets = validateSecretMap(decoded)
    for (const [ref, value] of Object.entries(secrets)) {
      vault.setSecret(ref, value)
      summary.secrets++
    }
  }

  for (const group of parsed.groups ?? []) {
    sessionStore.saveGroup(group)
    summary.groups++
  }
  for (const session of parsed.sessions ?? []) {
    sessionStore.saveSession(session)
    summary.sessions++
  }
  for (const snippet of parsed.snippets ?? []) {
    snippetStore.save(snippet)
    summary.snippets++
  }
  for (const collection of parsed.collections ?? []) {
    collectionStore.save(collection)
    summary.collections++
  }
  for (const source of parsed.inventorySources ?? []) {
    inventoryStore.saveSource(source)
    summary.inventorySources++
  }
  for (const override of parsed.inventoryOverrides ?? []) {
    inventoryStore.saveOverride(override)
    summary.inventoryOverrides++
  }
  for (const override of parsed.gitFolderOverrides ?? []) {
    gitFolderStore.saveOverride(override)
    summary.gitFolderOverrides++
  }
  for (const credential of parsed.credentials ?? []) {
    credentialStore.save(credential)
    summary.credentials++
  }

  return summary
}
