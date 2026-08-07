import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import type { HostCollection } from '../../shared/types'

interface CollectionFile {
  version: 1
  collections: HostCollection[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'collections.json')
}

/**
 * Hand-picked sets of hosts, kept apart from the session tree on purpose: a
 * host belongs to exactly one group but to any number of collections, and a
 * collection holds nothing but references — no credentials, so this file has
 * no secrets in it.
 */
class CollectionStore {
  private data: CollectionFile

  constructor() {
    this.data = this.load()
  }

  private load(): CollectionFile {
    const p = storePath()
    if (!existsSync(p)) return { version: 1, collections: [] }
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<CollectionFile>
      return { version: 1, collections: parsed.collections ?? [] }
    } catch {
      return { version: 1, collections: [] }
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const target = storePath()
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  list(): HostCollection[] {
    return this.data.collections
  }

  save(collection: HostCollection): HostCollection {
    // Duplicates would open the same host twice on a single click.
    const deduped = { ...collection, hostIds: [...new Set(collection.hostIds)] }
    const idx = this.data.collections.findIndex((c) => c.id === deduped.id)
    if (idx >= 0) this.data.collections[idx] = deduped
    else this.data.collections.push(deduped)
    this.persist()
    return deduped
  }

  /** Fixes the list order, so it is the user's to arrange rather than an
   * accident of when each set happened to be created. */
  reorder(ids: string[]): void {
    const byId = new Map(this.data.collections.map((c) => [c.id, c]))
    const next = ids.map((id) => byId.get(id)).filter((c): c is HostCollection => Boolean(c))
    for (const c of this.data.collections) {
      if (!next.includes(c)) next.push(c)
    }
    this.data.collections = next
    this.persist()
  }

  remove(id: string): void {
    this.data.collections = this.data.collections.filter((c) => c.id !== id)
    this.persist()
  }
}

export const collectionStore = new CollectionStore()
