import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { deriveKey, newSalt, encrypt, decrypt, wipe, type EncryptedPayload } from '../vault/crypto'
import { vault, type SealedSecrets } from '../vault/Vault'
import { writeJson } from './jsonFile'
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
    'consoleSession',
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

  // Through a temporary name, like every other file this application writes:
  // saving over last week's export must not leave half of this week's.
  writeJson(res.filePath, backup)
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

  let secrets: Record<string, string> | undefined
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
    secrets = validateSecretMap(decoded)
  }

  const { groups, sessions } = checkRelations(parsed)
  const snippets = parsed.snippets ?? []
  const collections = parsed.collections ?? []
  const sources = parsed.inventorySources ?? []
  const inventoryOverrides = parsed.inventoryOverrides ?? []
  const gitFolderOverrides = parsed.gitFolderOverrides ?? []
  const credentials = parsed.credentials ?? []

  /*
   * All of it or none of it.
   *
   * An import used to write item by item, store by store, and stop at the
   * first thing that failed — leaving the secrets in, half the hosts in, and
   * the rest not, with nothing to say where it had stopped. Importing the same
   * file again then merged over a half-finished one. Now everything is checked
   * and decrypted before anything is written, each store is written once, and
   * if one of those writes fails, every store already written is put back as it
   * was.
   */
  /*
   * Written down before the first store changes, and removed once the import
   * has either finished or been put back. The rollback below covers a write that
   * fails; it cannot cover the process ending between two writes — a crash, a
   * forced quit, the power. A journal left behind is that case, and the next
   * start puts every store back from it. See `recoverInterruptedImport`.
   */
  writeJson(journalPath(), {
    version: 1,
    startedAt: Date.now(),
    vault: secrets && Object.keys(secrets).length > 0 ? vault.sealedSecrets() : undefined,
    sessions: sessionStore.snapshot(),
    snippets: snippetStore.snapshot(),
    collections: collectionStore.snapshot(),
    inventory: inventoryStore.snapshot(),
    gitFolders: gitFolderStore.snapshot(),
    credentials: credentialStore.snapshot()
  } satisfies ImportJournal)

  const undo: (() => void)[] = []
  const step = <T>(snapshot: () => T, restore: (previous: T) => void, write: () => void): void => {
    const previous = snapshot()
    write()
    undo.push(() => restore(previous))
  }
  try {
    if (secrets && Object.keys(secrets).length > 0) {
      const values = secrets
      step(
        () => vault.snapshotSecrets(),
        (previous) => vault.restoreSecrets(previous),
        () => vault.setSecrets(values)
      )
    }
    step(
      () => sessionStore.snapshot(),
      (previous) => sessionStore.restore(previous),
      () => sessionStore.saveMany(groups, sessions)
    )
    step(
      () => snippetStore.snapshot(),
      (previous) => snippetStore.restore(previous),
      () => snippetStore.saveMany(snippets)
    )
    step(
      () => collectionStore.snapshot(),
      (previous) => collectionStore.restore(previous),
      () => collectionStore.saveMany(collections)
    )
    step(
      () => inventoryStore.snapshot(),
      (previous) => inventoryStore.restore(previous),
      () => inventoryStore.saveMany(sources, inventoryOverrides)
    )
    step(
      () => gitFolderStore.snapshot(),
      (previous) => gitFolderStore.restore(previous),
      () => gitFolderStore.saveOverrides(gitFolderOverrides)
    )
    step(
      () => credentialStore.snapshot(),
      (previous) => credentialStore.restore(previous),
      () => credentialStore.saveMany(credentials)
    )
  } catch (err) {
    const unrestored: string[] = []
    for (const put of undo.reverse()) {
      try {
        put()
      } catch (restoreErr) {
        unrestored.push((restoreErr as Error).message)
      }
    }
    // Put back in full: the journal has done its work. Otherwise it stays, and
    // the next start finishes the job.
    if (unrestored.length === 0) rmSync(journalPath(), { force: true })
    throw new Error(
      unrestored.length === 0
        ? `The import failed and nothing was changed: ${(err as Error).message}`
        : `The import failed (${(err as Error).message}), and putting everything back failed too (${unrestored.join('; ')}). Restart TerminalDeck: it will put back what was left before anything else.`
    )
  }
  rmSync(journalPath(), { force: true })

  return {
    groups: groups.length,
    sessions: sessions.length,
    snippets: snippets.length,
    collections: collections.length,
    inventorySources: sources.length,
    inventoryOverrides: inventoryOverrides.length,
    gitFolderOverrides: gitFolderOverrides.length,
    credentials: credentials.length,
    secrets: secrets ? Object.keys(secrets).length : 0
  }
}

function journalPath(): string {
  return join(app.getPath('userData'), 'import-journal.json')
}

/** What every store held before an import began. */
interface ImportJournal {
  version: 1
  startedAt: number
  vault?: SealedSecrets
  sessions: ReturnType<typeof sessionStore.snapshot>
  snippets: ReturnType<typeof snippetStore.snapshot>
  collections: ReturnType<typeof collectionStore.snapshot>
  inventory: ReturnType<typeof inventoryStore.snapshot>
  gitFolders: ReturnType<typeof gitFolderStore.snapshot>
  credentials: ReturnType<typeof credentialStore.snapshot>
}

/**
 * Finishes undoing an import the application did not live through.
 *
 * Called at start, before anything can read or change a store. Returns what
 * happened, so the caller can say so: an import that silently was not there
 * any more would be its own kind of puzzle.
 */
export function recoverInterruptedImport(): 'none' | 'restored' | 'failed' {
  const path = journalPath()
  if (!existsSync(path)) return 'none'
  let journal: ImportJournal
  try {
    journal = JSON.parse(readFileSync(path, 'utf8')) as ImportJournal
    if (journal.version !== 1) throw new Error('unknown journal version')
  } catch {
    // Written through a temporary name, so a damaged one was never finished —
    // and an import never starts writing before its journal is whole.
    renameSync(path, `${path}.damaged-${Date.now()}`)
    return 'none'
  }
  try {
    sessionStore.restore(journal.sessions)
    snippetStore.restore(journal.snippets)
    collectionStore.restore(journal.collections)
    inventoryStore.restore(journal.inventory)
    gitFolderStore.restore(journal.gitFolders)
    credentialStore.restore(journal.credentials)
    if (journal.vault) vault.restoreSealedSecrets(journal.vault)
  } catch {
    return 'failed'
  }
  rmSync(path, { force: true })
  return 'restored'
}

/**
 * What an import's groups and hosts say about each other, checked against what
 * is already here once it is merged.
 *
 * Each item was validated on its own, which says nothing about the tree they
 * make together. Two entries with one id would be merged silently into one. A
 * group that names itself as its own ancestor, directly or three levels up,
 * sends anything that walks up the tree — inheritance, above all — round in a
 * circle for good. And a host or group whose parent is in neither the file nor
 * this machine ends up in no folder the sidebar can show: it is imported and
 * invisible. The first two refuse the file; the last is put at the top level,
 * where it can be seen and moved.
 */
function checkRelations(parsed: BackupFile): {
  groups: SessionGroup[]
  sessions: SessionProfile[]
} {
  const duplicate = (ids: string[], what: string): void => {
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) invalid(`${what} contains the id ${JSON.stringify(id)} more than once`)
      seen.add(id)
    }
  }
  duplicate(
    parsed.groups.map((g) => g.id),
    'backup.groups'
  )
  duplicate(
    parsed.sessions.map((s) => s.id),
    'backup.sessions'
  )

  const merged = new Map(sessionStore.getAll().groups.map((g) => [g.id, g] as const))
  for (const group of parsed.groups) merged.set(group.id, group)

  const groups = parsed.groups.map((g) =>
    g.parentId !== null && !merged.has(g.parentId) ? { ...g, parentId: null } : g
  )
  for (const group of groups) merged.set(group.id, group)

  for (const group of groups) {
    const visited = new Set<string>()
    let cursor: SessionGroup | undefined = group
    while (cursor && cursor.parentId !== null) {
      if (visited.has(cursor.id)) invalid(`backup.groups: ${group.name} is its own ancestor`)
      visited.add(cursor.id)
      cursor = merged.get(cursor.parentId)
    }
  }

  const sessions = parsed.sessions.map((s) =>
    s.groupId !== null && !merged.has(s.groupId) ? { ...s, groupId: null } : s
  )
  return { groups, sessions }
}
