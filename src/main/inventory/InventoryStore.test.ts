import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { InventorySource } from '../../shared/types'

/**
 * A sync that finishes after its source has changed.
 *
 * Git and the parse are stood in for by promises the test settles, so the
 * source can be edited or removed at exactly the moment the sync is waiting.
 */

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

let finishParse: () => void = () => undefined
vi.mock('./GitRepo', () => ({
  syncRepo: async () => '/checkout',
  headRevision: async () => 'abc123'
}))
vi.mock('./parseInWorker', () => ({
  parseInWorker: () =>
    new Promise((resolve) => {
      finishParse = () =>
        resolve({
          files: ['/checkout/hosts.yml'],
          groups: [],
          hosts: [{ id: 'inv:src:host:web', name: 'web', host: '10.0.0.1' }],
          memberships: {}
        })
    })
}))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-inventory-'))
const { inventoryStore } = await import('./InventoryStore')

const source: InventorySource = {
  id: 'src',
  name: 'infra',
  repoUrl: 'git@example.com:old.git',
  paths: ['hosts.yml']
}

async function parsing(): Promise<void> {
  // The sync has reached the parse once `finishParse` belongs to it.
  await vi.waitFor(() => expect(finishParse).not.toBe(noop))
}
const noop = (): void => undefined

beforeEach(() => {
  finishParse = noop
  for (const s of [...inventoryStore.sources()]) inventoryStore.removeSource(s.id)
})

describe('a sync overtaken by an edit', () => {
  it('drops what it read when the source is removed meanwhile', async () => {
    inventoryStore.saveSource(source)
    const syncing = inventoryStore.sync('src')
    await parsing()

    inventoryStore.removeSource('src')
    finishParse()

    await expect(syncing).rejects.toThrow(/removed/i)
    expect(inventoryStore.allTrees()).toEqual([])
    expect(inventoryStore.sources()).toEqual([])
  })

  it('drops what it read when the source is pointed somewhere else meanwhile', async () => {
    inventoryStore.saveSource(source)
    const syncing = inventoryStore.sync('src')
    await parsing()

    inventoryStore.saveSource({ ...source, repoUrl: 'git@example.com:new.git' })
    finishParse()

    await expect(syncing).rejects.toThrow(/changed/i)
    expect(inventoryStore.allTrees()).toEqual([])
    expect(inventoryStore.sources()[0]).toEqual({ ...source, repoUrl: 'git@example.com:new.git' })
  })

  it('keeps the result of a sync nothing interfered with', async () => {
    inventoryStore.saveSource(source)
    const syncing = inventoryStore.sync('src')
    await parsing()
    // A rename changes nothing the sync read.
    inventoryStore.saveSource({ ...source, name: 'renamed' })
    finishParse()

    await syncing
    expect(inventoryStore.allTrees()).toHaveLength(1)
    expect(inventoryStore.sources()[0]).toMatchObject({ name: 'renamed', lastRevision: 'abc123' })
  })

  /**
   * A login changed while the repository was being read. The source saved the
   * new one, and the tree was published with the old: hosts went on signing in
   * as the account that had just been replaced.
   */
  it('publishes the source as it is when the sync ends', async () => {
    inventoryStore.saveSource({ ...source, username: 'old-login' })
    const syncing = inventoryStore.sync('src')
    await parsing()
    inventoryStore.saveSource({ ...source, username: 'new-login', name: 'renamed' })
    finishParse()

    const tree = await syncing
    expect(tree.groups[0]).toMatchObject({ name: 'renamed', username: 'new-login' })
  })

  it('runs a fresh sync for a source saved while one was running', async () => {
    inventoryStore.saveSource(source)
    const first = inventoryStore.sync('src')
    await parsing()
    const firstFinish = finishParse

    const moved = { ...source, repoUrl: 'git@example.com:new.git' }
    inventoryStore.saveSource(moved)
    finishParse = noop
    const second = inventoryStore.sync('src')
    expect(second).not.toBe(first)

    firstFinish()
    await expect(first).rejects.toThrow(/changed/i)
    await vi.waitFor(() => expect(finishParse).not.toBe(noop))
    finishParse()
    await expect(second).resolves.toMatchObject({ sourceId: 'src' })
    expect(inventoryStore.allTrees()).toHaveLength(1)
  })
})
