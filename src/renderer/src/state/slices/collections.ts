import type { StateCreator } from 'zustand'
import { colorOf, findHost } from '../hosts'
import type { AppState, CollectionsSlice, OpenRequest } from './types'

export const createCollectionsSlice: StateCreator<AppState, [], [], CollectionsSlice> = (
  set,
  get
) => ({
  collections: [],

  loadCollections: async () => {
    set({ collections: await window.td.collections.list() })
  },

  upsertCollection: async (collection) => {
    await window.td.collections.save({ ...collection, updatedAt: Date.now() })
    await get().loadCollections()
  },

  removeCollection: async (id) => {
    await window.td.collections.remove(id)
    await get().loadCollections()
  },

  moveCollection: async (id, delta) => {
    const order = get().collections.map((c) => c.id)
    const from = order.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
    await window.td.collections.reorder(order)
    await get().loadCollections()
  },

  addToCollection: async (id, hostIds) => {
    const collection = get().collections.find((c) => c.id === id)
    if (!collection) return
    await get().upsertCollection({
      ...collection,
      hostIds: [...new Set([...collection.hostIds, ...hostIds])]
    })
  },

  removeFromCollection: async (id, hostId) => {
    const collection = get().collections.find((c) => c.id === id)
    if (!collection) return
    await get().upsertCollection({
      ...collection,
      hostIds: collection.hostIds.filter((x) => x !== hostId)
    })
  },

  openCollection: (id) => {
    const state = get()
    const collection = state.collections.find((c) => c.id === id)
    if (!collection) return

    const items: OpenRequest[] = []
    for (const hostId of collection.hostIds) {
      const found = findHost(state, hostId)
      // A host can be deleted, or vanish from an inventory after a sync. Skip it
      // here; the panel lists it as missing so it is not silently forgotten.
      if (!found) continue
      items.push({
        title: found.host.name,
        target: { kind: 'session', sessionId: hostId },
        // The set being opened lends its colour. A host in several looks like
        // whichever one you came in through; one marked on purpose keeps its own.
        color: colorOf(found.host, collection),
        viaCollectionId: collection.id
      })
    }
    if (items.length > 0) state.openMany(items, 'workspace', collection.name)
  }
})
