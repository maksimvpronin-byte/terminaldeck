import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { deriveKey, decrypt, type EncryptedPayload } from '../vault/crypto'
import type {
  Credential,
  HostCollection,
  InventoryOverride,
  InventorySource,
  SessionGroup,
  SessionProfile,
  Snippet
} from '../../shared/types'

/**
 * Both halves of the file dialog are answered from these two variables, so a
 * test says where the export lands and which file the import reads by setting
 * them. Undefined stands for the user cancelling.
 *
 * The stores read `app.getPath` in their constructors, not lazily like the
 * vault, so every module under test is pulled in dynamically — after the
 * temporary directory exists.
 */
let userData = ''
let saveTo: string | undefined
let openFrom: string | undefined

vi.mock('electron', () => ({
  app: { getPath: (): string => userData },
  dialog: {
    showSaveDialog: async () => ({ canceled: saveTo === undefined, filePath: saveTo }),
    showOpenDialog: async () => ({
      canceled: openFrom === undefined,
      filePaths: openFrom ? [openFrom] : []
    })
  }
}))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-backup-'))
const { vault } = await import('../vault/Vault')
const { sessionStore } = await import('./SessionStore')
const { snippetStore } = await import('./SnippetStore')
const { collectionStore } = await import('./CollectionStore')
const { credentialStore } = await import('./CredentialStore')
const { inventoryStore } = await import('../inventory/InventoryStore')
const { exportToFile, importFromFile } = await import('./Backup')

/** The dialog is mocked, so nothing here ever reaches a real window. */
const win = {} as BrowserWindow

const MASTER = 'the master password'
const OTHER_MASTER = 'the master password on the other machine'
const EXPORT_PASSWORD = 'the password on the file itself'

const FILE = join(userData, 'export.json')

const group: SessionGroup = {
  id: 'group-1',
  name: 'Production',
  parentId: null,
  username: 'ops',
  authMethod: 'password',
  secretRef: 'secret-group'
}

const session: SessionProfile = {
  id: 'session-1',
  name: 'web-1',
  host: '10.0.0.1',
  groupId: 'group-1',
  tags: ['web'],
  logToFile: false,
  portForwards: [],
  createdAt: 1,
  updatedAt: 2,
  username: 'root',
  authMethod: 'password',
  secretRef: 'secret-session'
}

const snippet: Snippet = {
  id: 'snippet-1',
  name: 'tail the log',
  command: 'tail -f /var/log/syslog',
  tags: [],
  createdAt: 1,
  updatedAt: 2
}

const collection: HostCollection = {
  id: 'collection-1',
  name: 'Databases',
  hostIds: ['session-1'],
  createdAt: 1,
  updatedAt: 2
}

const source: InventorySource = {
  id: 'source-1',
  name: 'infra',
  repoUrl: 'git@example.com:infra.git',
  paths: ['inventories/prod'],
  username: 'ansible',
  secretRef: 'secret-source'
}

const override: InventoryOverride = {
  nodeId: 'inv:source-1:host:db-1',
  secretRef: 'secret-override'
}

const credential: Credential = {
  id: 'credential-1',
  name: 'domain admin',
  username: 'CORP\\admin',
  authMethod: 'password',
  secretRef: 'secret-credential',
  createdAt: 1,
  updatedAt: 2
}

const SECRETS = {
  'secret-group': 'group password',
  'secret-session': 'hunter2',
  'secret-source': 'repo password',
  'secret-override': 'пароль-🔐',
  'secret-credential': 'the administrator password'
}

function populate(): void {
  sessionStore.saveGroup(group)
  sessionStore.saveSession(session)
  snippetStore.save(snippet)
  collectionStore.save(collection)
  inventoryStore.saveSource(source)
  inventoryStore.saveOverride(override)
  credentialStore.save(credential)
  for (const [ref, value] of Object.entries(SECRETS)) vault.setSecret(ref, value)
}

function clearStores(): void {
  for (const s of [...sessionStore.getAll().sessions]) sessionStore.deleteSession(s.id)
  for (const g of [...sessionStore.getAll().groups]) sessionStore.deleteGroup(g.id)
  for (const s of [...snippetStore.list()]) snippetStore.remove(s.id)
  for (const c of [...collectionStore.list()]) collectionStore.remove(c.id)
  for (const s of [...inventoryStore.sources()]) inventoryStore.removeSource(s.id)
  for (const o of [...inventoryStore.overrides()]) inventoryStore.clearOverride(o.nodeId)
  for (const c of [...credentialStore.list()]) credentialStore.remove(c.id)
}

/** A detached copy, so a later mutation of the stores cannot change it under us. */
function clone(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/** Everything the stores hold, in one object, for comparing before and after. */
function snapshot(): Record<string, unknown> {
  return {
    groups: sessionStore.getAll().groups,
    sessions: sessionStore.getAll().sessions,
    snippets: snippetStore.list(),
    collections: collectionStore.list(),
    sources: inventoryStore.sources(),
    overrides: inventoryStore.overrides(),
    credentials: credentialStore.list()
  }
}

/** Stands in for carrying the file to a different machine. */
async function startAgainWithAnEmptyVault(): Promise<void> {
  clearStores()
  vault.lock()
  rmSync(join(userData, 'vault.json'), { force: true })
  await vault.create(OTHER_MASTER)
}

beforeEach(async () => {
  saveTo = undefined
  openFrom = undefined
  clearStores()
  vault.lock()
  rmSync(join(userData, 'vault.json'), { force: true })
  rmSync(FILE, { force: true })
  await vault.create(MASTER)
})

describe('backup export', () => {
  it('writes nothing when the dialog is cancelled', async () => {
    populate()
    expect(await exportToFile(win, false)).toBeUndefined()
    expect(existsSync(FILE)).toBe(false)
  })

  it('refuses to carry credentials without a password for them', async () => {
    populate()
    saveTo = FILE
    await expect(exportToFile(win, true)).rejects.toThrow(/password is required/i)
    expect(existsSync(FILE)).toBe(false)
  })

  it('leaves credentials out entirely when they were not asked for', async () => {
    populate()
    saveTo = FILE

    await exportToFile(win, false)

    const raw = readFileSync(FILE, 'utf8')
    expect(JSON.parse(raw).secrets).toBeUndefined()
    for (const value of Object.values(SECRETS)) expect(raw).not.toContain(value)
  })

  it('never writes a credential in the clear', async () => {
    populate()
    saveTo = FILE

    await exportToFile(win, true, EXPORT_PASSWORD)

    const raw = readFileSync(FILE, 'utf8')
    for (const value of Object.values(SECRETS)) expect(raw).not.toContain(value)
  })

  /**
   * The vault outlives the sessions that filled it, and an export is the one
   * moment those orphans could leave the machine. They must not.
   */
  it('carries only the secrets something in the export points at', async () => {
    populate()
    vault.setSecret('secret-orphan', 'belonged to a host deleted long ago')
    saveTo = FILE

    await exportToFile(win, true, EXPORT_PASSWORD)

    const file = JSON.parse(readFileSync(FILE, 'utf8')) as {
      secrets: { salt: string; payload: EncryptedPayload }
    }
    const carried = JSON.parse(
      decrypt(await deriveKey(EXPORT_PASSWORD, file.secrets.salt), file.secrets.payload)
    ) as Record<string, string>

    expect(carried).toEqual(SECRETS)
    expect(carried['secret-orphan']).toBeUndefined()
  })
})

describe('backup import', () => {
  it('reads nothing when the dialog is cancelled', async () => {
    populate()
    const before = clone(snapshot())

    expect(await importFromFile(win)).toBeUndefined()
    expect(snapshot()).toEqual(before)
  })

  /** The whole point of the feature: everything arrives on a machine that had none of it. */
  it('brings a whole configuration back, credentials included', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, true, EXPORT_PASSWORD)
    const before = clone(snapshot())

    await startAgainWithAnEmptyVault()
    openFrom = FILE
    const summary = await importFromFile(win, EXPORT_PASSWORD)

    expect(summary).toEqual({
      groups: 1,
      sessions: 1,
      snippets: 1,
      collections: 1,
      inventorySources: 1,
      inventoryOverrides: 1,
      credentials: 1,
      secrets: 5
    })
    expect(snapshot()).toEqual(before)
    // Re-encrypted on the way in: the same secrets, under the new master password.
    for (const [ref, value] of Object.entries(SECRETS)) {
      expect(vault.getSecret(ref)).toBe(value)
    }
  })

  it('survives the round trip through a locked and reopened vault', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, true, EXPORT_PASSWORD)

    await startAgainWithAnEmptyVault()
    openFrom = FILE
    await importFromFile(win, EXPORT_PASSWORD)
    vault.lock()
    await vault.unlock(OTHER_MASTER)

    expect(vault.getSecret('secret-session')).toBe('hunter2')
  })

  it('replaces an entry of the same id and leaves the rest alone', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, false)

    clearStores()
    sessionStore.saveSession({ ...session, name: 'renamed since', host: '10.0.0.99' })
    sessionStore.saveSession({ ...session, id: 'session-untouched', name: 'not in the export' })

    openFrom = FILE
    await importFromFile(win)

    const sessions = sessionStore.getAll().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === 'session-1')).toEqual(session)
    expect(sessions.find((s) => s.id === 'session-untouched')?.name).toBe('not in the export')
  })

  it('refuses a file that is not an export, and changes nothing', async () => {
    populate()
    const before = clone(snapshot())
    writeFileSync(FILE, JSON.stringify({ format: 'something-else', sessions: [] }), 'utf8')
    openFrom = FILE

    await expect(importFromFile(win)).rejects.toThrow(/not a TerminalDeck export/i)
    expect(snapshot()).toEqual(before)
  })

  it('refuses a truncated file, and changes nothing', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, false)
    const before = clone(snapshot())
    const raw = readFileSync(FILE, 'utf8')
    writeFileSync(FILE, raw.slice(0, Math.floor(raw.length / 2)), 'utf8')
    openFrom = FILE

    await expect(importFromFile(win)).rejects.toThrow()
    expect(snapshot()).toEqual(before)
  })

  /**
   * Secrets are applied before anything else, so a wrong password stops the
   * import while the stores are still untouched — rather than half-importing a
   * tree of hosts none of which can sign in.
   */
  it('refuses the wrong password without importing half of the file', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, true, EXPORT_PASSWORD)

    await startAgainWithAnEmptyVault()
    openFrom = FILE

    await expect(importFromFile(win, 'not the password')).rejects.toThrow(/wrong password/i)
    expect(sessionStore.getAll().sessions).toEqual([])
    expect(sessionStore.getAll().groups).toEqual([])
    expect(vault.getSecret('secret-session')).toBeUndefined()
  })

  it('says so when the file has credentials and no password was given', async () => {
    populate()
    saveTo = FILE
    await exportToFile(win, true, EXPORT_PASSWORD)

    await startAgainWithAnEmptyVault()
    openFrom = FILE

    await expect(importFromFile(win)).rejects.toThrow(/needs its password/i)
    expect(sessionStore.getAll().sessions).toEqual([])
  })
})
