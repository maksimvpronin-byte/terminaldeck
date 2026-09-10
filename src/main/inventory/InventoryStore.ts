import { app } from 'electron'
import { join, relative } from 'path'
import type {
  InventoryData,
  InventoryOverride,
  InventorySource,
  InventoryTree
} from '../../shared/types'
import { parseInWorker } from './parseInWorker'
import { noInventoryFound } from './files'
import { syncRepo, headRevision } from './GitRepo'
import { applyOverride, withoutBlanks } from '../../shared/overrides'
import { readJson, writeJson } from '../store/jsonFile'

function configPath(): string {
  return join(app.getPath('userData'), 'inventories.json')
}

function reposRoot(): string {
  return join(app.getPath('userData'), 'inventory-repos')
}

class InventoryStore {
  private data: InventoryData
  /** Last successful parse per source; rebuilt on every sync. */
  private trees = new Map<string, InventoryTree>()

  constructor() {
    this.data = this.load()
  }

  private load(): InventoryData {
    // Normalised after reading rather than trusted: a file written by an older
    // version, or edited by hand, may be missing either list.
    const parsed = readJson<Partial<InventoryData>>(configPath(), () => ({}))
    return { version: 1, sources: parsed.sources ?? [], overrides: parsed.overrides ?? [] }
  }

  private persist(): void {
    writeJson(configPath(), this.data)
  }

  sources(): InventorySource[] {
    return this.data.sources
  }

  overrides(): InventoryOverride[] {
    return this.data.overrides
  }

  saveSource(source: InventorySource): InventorySource {
    const idx = this.data.sources.findIndex((s) => s.id === source.id)
    if (idx >= 0) this.data.sources[idx] = source
    else this.data.sources.push(source)
    this.persist()
    return source
  }

  removeSource(id: string): void {
    this.data.sources = this.data.sources.filter((s) => s.id !== id)
    // Overrides for hosts that can no longer appear are dead weight.
    this.data.overrides = this.data.overrides.filter((o) => !o.nodeId.startsWith(`inv:${id}:`))
    this.trees.delete(id)
    this.persist()
  }

  saveOverride(override: InventoryOverride): void {
    const idx = this.data.overrides.findIndex((o) => o.nodeId === override.nodeId)
    if (idx >= 0) this.data.overrides[idx] = override
    else this.data.overrides.push(override)
    this.persist()
  }

  clearOverride(nodeId: string): void {
    this.data.overrides = this.data.overrides.filter((o) => o.nodeId !== nodeId)
    this.persist()
  }

  allTrees(): InventoryTree[] {
    return [...this.trees.values()]
  }

  /** The host as it will be used: parsed from the repo, then the local override on top. */
  findSession(sessionId: string): import('../../shared/types').SessionProfile | undefined {
    for (const tree of this.trees.values()) {
      const found = tree.sessions.find((s) => s.id === sessionId)
      if (!found) continue
      return applyOverride(
        found,
        this.data.overrides.find((o) => o.nodeId === sessionId)
      )
    }
    return undefined
  }

  /**
   * All groups across every synced source, with local overrides applied — a
   * group override has to be visible to auth resolution, not just to the tree.
   */
  allGroups(): import('../../shared/types').SessionGroup[] {
    return [...this.trees.values()]
      .flatMap((t) => t.groups)
      .map((g) =>
        applyOverride(
          g,
          this.data.overrides.find((o) => o.nodeId === g.id)
        )
      )
  }

  private syncing = new Map<string, Promise<InventoryTree>>()
  sync(sourceId: string): Promise<InventoryTree> {
    const pending = this.syncing.get(sourceId)
    if (pending) return pending
    const next = this.syncSource(sourceId).finally(() => this.syncing.delete(sourceId))
    this.syncing.set(sourceId, next)
    return next
  }

  private async syncSource(sourceId: string): Promise<InventoryTree> {
    const source = this.data.sources.find((s) => s.id === sourceId)
    if (!source) throw new Error('Unknown inventory source')

    try {
      const dir = await syncRepo(reposRoot(), source.id, source.repoUrl, source.branch)

      // The source itself is the tree's root group, so credentials set on it are
      // inherited by every group and host the repository produces.
      const rootId = `inv:${sourceId}:root`
      const { id: _id, name, repoUrl: _url, branch: _br, paths: _p, ...sourceAuth } = source
      const tree: InventoryTree = {
        sourceId,
        groups: [{ ...withoutBlanks(sourceAuth), id: rootId, name, parentId: null }],
        sessions: [],
        memberships: {}
      }
      const parsed = await parseInWorker({
        dir,
        paths: source.paths,
        sourceId,
        prefix: 'inv',
        rootId
      })
      const { files } = parsed
      tree.groups.push(...parsed.groups)
      tree.sessions = parsed.hosts
      tree.memberships = parsed.memberships

      this.trees.set(sourceId, tree)
      source.lastSyncedAt = Date.now()
      source.lastRevision = await headRevision(dir).catch(() => undefined)
      source.lastError = undefined
      source.lastFiles = files.map((f) => relative(dir, f))
      if (files.length === 0) {
        source.lastError = noInventoryFound(source.paths)
      }
      this.persist()
      return tree
    } catch (err) {
      source.lastError = (err as Error).message
      this.persist()
      throw err
    }
  }

  async syncAll(): Promise<void> {
    for (const source of this.data.sources) {
      // One broken repository must not stop the others from loading.
      await this.sync(source.id).catch(() => undefined)
    }
  }
}

export const inventoryStore = new InventoryStore()
