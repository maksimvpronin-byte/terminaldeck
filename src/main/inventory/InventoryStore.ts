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
import { JsonDocument, readJson } from '../store/jsonFile'

function configPath(): string {
  return join(app.getPath('userData'), 'inventories.json')
}

function reposRoot(): string {
  return join(app.getPath('userData'), 'inventory-repos')
}

/** What decides the contents a sync reads; anything else can change under it harmlessly. */
function readsTheSame(a: InventorySource, b: InventorySource): boolean {
  return (
    a.repoUrl === b.repoUrl &&
    (a.branch ?? '') === (b.branch ?? '') &&
    JSON.stringify(a.paths) === JSON.stringify(b.paths)
  )
}

/** Everything about a source that shapes the tree a sync publishes. */
function settingsOf(source: InventorySource): string {
  const { lastSyncedAt: _t, lastRevision: _r, lastError: _e, lastFiles: _f, ...settings } = source
  return JSON.stringify(settings)
}

/** The source itself as the root of its tree, so what is set on it is inherited below. */
function rootGroupOf(source: InventorySource, rootId: string): InventoryTree['groups'][number] {
  const {
    id: _id,
    name,
    repoUrl: _url,
    branch: _br,
    paths: _p,
    lastSyncedAt: _t,
    lastRevision: _r,
    lastError: _e,
    lastFiles: _f,
    ...sourceAuth
  } = source
  return { ...withoutBlanks(sourceAuth), id: rootId, name, parentId: null }
}

/** Replaces the entry with the same key, or adds it at the end. */
function upsertBy<T>(list: T[], item: T, same: (a: T, b: T) => boolean): void {
  const idx = list.findIndex((existing) => same(existing, item))
  if (idx >= 0) list[idx] = item
  else list.push(item)
}

/** A sync whose source was removed or re-pointed while it ran; its result is dropped. */
class StaleSyncError extends Error {}

class InventoryStore {
  // Normalised after reading rather than trusted: a file written by an older
  // version, or edited by hand, may be missing either list.
  private doc = new JsonDocument<InventoryData>(configPath, (path) => {
    const parsed = readJson<Partial<InventoryData>>(path, () => ({}))
    return { version: 1, sources: parsed.sources ?? [], overrides: parsed.overrides ?? [] }
  })
  /** Last successful parse per source; rebuilt on every sync. */
  private trees = new Map<string, InventoryTree>()

  sources(): InventorySource[] {
    return this.doc.data.sources
  }

  overrides(): InventoryOverride[] {
    return this.doc.data.overrides
  }

  saveSource(source: InventorySource): InventorySource {
    this.doc.change((d) => upsertBy(d.sources, source, (a, b) => a.id === b.id))
    return source
  }

  removeSource(id: string): void {
    this.doc.change((d) => {
      d.sources = d.sources.filter((s) => s.id !== id)
      // Overrides for hosts that can no longer appear are dead weight.
      d.overrides = d.overrides.filter((o) => !o.nodeId.startsWith(`inv:${id}:`))
    })
    this.trees.delete(id)
  }

  saveOverride(override: InventoryOverride): void {
    this.saveMany([], [override])
  }

  /** Several sources and overrides in one write, for an import. */
  saveMany(sources: InventorySource[], overrides: InventoryOverride[]): void {
    this.doc.change((d) => {
      for (const source of sources) upsertBy(d.sources, source, (a, b) => a.id === b.id)
      for (const override of overrides) {
        upsertBy(d.overrides, override, (a, b) => a.nodeId === b.nodeId)
      }
    })
  }

  clearOverride(nodeId: string): void {
    this.doc.change((d) => {
      d.overrides = d.overrides.filter((o) => o.nodeId !== nodeId)
    })
  }

  snapshot(): InventoryData {
    return this.doc.snapshot()
  }

  restore(previous: InventoryData): void {
    this.doc.restore(previous)
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
        this.doc.data.overrides.find((o) => o.nodeId === sessionId)
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
          this.doc.data.overrides.find((o) => o.nodeId === g.id)
        )
      )
  }

  private syncing = new Map<string, { promise: Promise<InventoryTree>; source: string }>()

  /**
   * One sync per source at a time — and the one a caller gets is for the source
   * as it is now.
   *
   * Asking while a sync was running handed back the running one. Saving a source
   * starts a sync straight after, so a save made during a sync got the result of
   * the settings from before it: the old address, or a tree read with paths
   * that no longer applied. A request for a source that has changed since the
   * running sync began now waits for that one and then runs its own.
   */
  sync(sourceId: string): Promise<InventoryTree> {
    const running = this.syncing.get(sourceId)
    const now = this.doc.data.sources.find((s) => s.id === sourceId)
    if (running) {
      if (!now || running.source === settingsOf(now)) return running.promise
      return running.promise.catch(() => undefined).then(() => this.sync(sourceId))
    }
    const entry = {
      source: now ? settingsOf(now) : '',
      promise: this.syncSource(sourceId).finally(() => {
        if (this.syncing.get(sourceId) === entry) this.syncing.delete(sourceId)
      })
    }
    this.syncing.set(sourceId, entry)
    return entry.promise
  }

  /**
   * The source as it stands now, if it still reads what `requested` read.
   *
   * A sync takes seconds to minutes, and the source can be removed or pointed
   * at another repository while it runs. Finishing regardless put the old
   * repository's hosts back under a source that had been deleted — or under the
   * new address, labelled as synced from it — and wrote its bookkeeping over
   * whatever had been saved in the meantime.
   */
  private stillCurrent(requested: InventorySource): InventorySource | undefined {
    const now = this.doc.data.sources.find((s) => s.id === requested.id)
    return now && readsTheSame(now, requested) ? now : undefined
  }

  /** Records the outcome of a sync on the source as it is now, not as it was. */
  private noteSync(sourceId: string, patch: Partial<InventorySource>): void {
    this.doc.change((d) => {
      const idx = d.sources.findIndex((s) => s.id === sourceId)
      if (idx >= 0) d.sources[idx] = { ...d.sources[idx], ...patch }
    })
  }

  private async syncSource(sourceId: string): Promise<InventoryTree> {
    const source = this.doc.data.sources.find((s) => s.id === sourceId)
    if (!source) throw new Error('Unknown inventory source')

    try {
      const dir = await syncRepo(reposRoot(), source.id, source.repoUrl, source.branch)

      // The source itself is the tree's root group, so credentials set on it are
      // inherited by every group and host the repository produces.
      const rootId = `inv:${sourceId}:root`
      const parsed = await parseInWorker({
        dir,
        paths: source.paths,
        sourceId,
        prefix: 'inv',
        rootId
      })
      const { files } = parsed
      const revision = await headRevision(dir).catch(() => undefined)

      const current = this.stillCurrent(source)
      if (!current) {
        throw new StaleSyncError(
          this.doc.data.sources.some((s) => s.id === sourceId)
            ? 'This source was changed while it was syncing. Sync it again.'
            : 'This source was removed while it was syncing.'
        )
      }
      /*
       * The root group is built from the source as it is now, not as it was when
       * the sync began. A login, a port or a name changed while the repository
       * was being read was saved, and the tree was then published with the old
       * one — so hosts went on connecting as the account that had just been
       * replaced, until the next sync.
       */
      const tree: InventoryTree = {
        sourceId,
        groups: [rootGroupOf(current, rootId), ...parsed.groups],
        sessions: parsed.hosts,
        memberships: parsed.memberships
      }
      this.noteSync(sourceId, {
        lastSyncedAt: Date.now(),
        lastRevision: revision,
        lastFiles: files.map((f) => relative(dir, f)),
        lastError: files.length === 0 ? noInventoryFound(source.paths) : undefined
      })
      this.trees.set(sourceId, tree)
      return tree
    } catch (err) {
      // Said on the source only if it is still the one that failed.
      if (!(err instanceof StaleSyncError) && this.stillCurrent(source)) {
        this.noteSync(sourceId, { lastError: (err as Error).message })
      }
      throw err
    }
  }

  async syncAll(): Promise<void> {
    for (const source of [...this.doc.data.sources]) {
      // One broken repository must not stop the others from loading.
      await this.sync(source.id).catch(() => undefined)
    }
  }
}

export const inventoryStore = new InventoryStore()
