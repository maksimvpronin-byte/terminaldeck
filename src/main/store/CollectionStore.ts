import { app } from 'electron'
import { join } from 'path'
import type { HostCollection } from '../../shared/types'
import { JsonDocument, readJson } from './jsonFile'

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
  private doc = new JsonDocument<CollectionFile>(storePath, (path) =>
    readJson<CollectionFile>(path, () => ({ version: 1, collections: [] }))
  )

  list(): HostCollection[] {
    return this.doc.data.collections
  }

  save(collection: HostCollection): HostCollection {
    return this.saveMany([collection])[0]
  }

  /** Several at once, in one write. */
  saveMany(collections: HostCollection[]): HostCollection[] {
    // Duplicates would open the same host twice on a single click.
    const deduped = collections.map((c) => ({ ...c, hostIds: [...new Set(c.hostIds)] }))
    this.doc.change((d) => {
      for (const collection of deduped) {
        const idx = d.collections.findIndex((c) => c.id === collection.id)
        if (idx >= 0) d.collections[idx] = collection
        else d.collections.push(collection)
      }
    })
    return deduped
  }

  /** Fixes the list order, so it is the user's to arrange rather than an
   * accident of when each set happened to be created. */
  reorder(ids: string[]): void {
    this.doc.change((d) => {
      const byId = new Map(d.collections.map((c) => [c.id, c]))
      const next = ids.map((id) => byId.get(id)).filter((c): c is HostCollection => Boolean(c))
      for (const c of d.collections) {
        if (!next.includes(c)) next.push(c)
      }
      d.collections = next
    })
  }

  remove(id: string): void {
    this.doc.change((d) => {
      d.collections = d.collections.filter((c) => c.id !== id)
    })
  }

  snapshot(): CollectionFile {
    return this.doc.snapshot()
  }

  restore(previous: CollectionFile): void {
    this.doc.restore(previous)
  }
}

export const collectionStore = new CollectionStore()
