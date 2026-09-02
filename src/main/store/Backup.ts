import { dialog, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { deriveKey, newSalt, encrypt, decrypt, wipe, type EncryptedPayload } from '../vault/crypto'
import { vault } from '../vault/Vault'
import { sessionStore } from './SessionStore'
import { snippetStore } from './SnippetStore'
import { collectionStore } from './CollectionStore'
import { credentialStore } from './CredentialStore'
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
   * Logins saved on their own. Absent from a file written before they existed,
   * which is why every reader here treats the list as optional.
   */
  credentials?: Credential[]
  /** Present only when secrets were included; encrypted under its own password. */
  secrets?: { salt: string; payload: EncryptedPayload }
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
        ...(backup.credentials ?? [])
      ]
        .map((item) => item.secretRef)
        .filter((ref): ref is string => Boolean(ref))
    )
    const all = vault.allSecrets()
    const referenced = Object.fromEntries(
      Object.entries(all).filter(([ref]) => wanted.has(ref))
    )

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

  const parsed = JSON.parse(readFileSync(res.filePaths[0], 'utf8')) as Partial<BackupFile>
  if (parsed.format !== 'terminaldeck-backup') {
    throw new Error('That file is not a TerminalDeck export')
  }

  const summary: ImportSummary = {
    groups: 0,
    sessions: 0,
    snippets: 0,
    collections: 0,
    inventorySources: 0,
    inventoryOverrides: 0,
    credentials: 0,
    secrets: 0
  }

  // Secrets first: a session is useless if its credential lands later and fails.
  if (parsed.secrets) {
    if (!password) throw new Error('This export contains credentials and needs its password')
    let secrets: Record<string, string>
    // Derived outside the try: deriving cannot fail for a wrong password, and
    // reporting an out-of-memory as "wrong password" would send someone hunting
    // for a password that was right all along.
    const key = await deriveKey(password, parsed.secrets.salt)
    try {
      secrets = JSON.parse(decrypt(key, parsed.secrets.payload)) as Record<string, string>
    } catch {
      throw new Error('Wrong password for the credentials in this export')
    } finally {
      wipe(key)
    }
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
  for (const credential of parsed.credentials ?? []) {
    credentialStore.save(credential)
    summary.credentials++
  }

  return summary
}
