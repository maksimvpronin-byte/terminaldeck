import type { StateCreator } from 'zustand'
import type { AppState, InventorySlice } from './types'

export const createInventorySlice: StateCreator<AppState, [], [], InventorySlice> = (set, get) => ({
  inventorySources: [],
  inventoryOverrides: [],
  inventoryTrees: [],
  inventorySyncing: [],
  inventorySyncErrors: {},
  gitAvailable: true,

  loadInventory: async () => {
    const [data, gitAvailable] = await Promise.all([
      window.td.inventory.list(),
      window.td.inventory.gitAvailable()
    ])
    set({
      inventorySources: data.sources,
      inventoryOverrides: data.overrides,
      inventoryTrees: data.trees,
      gitAvailable
    })
  },

  syncInventory: async (sourceId) => {
    const ids = sourceId ? [sourceId] : get().inventorySources.map((s) => s.id)
    set((s) => ({
      inventorySyncing: [...s.inventorySyncing, ...ids],
      inventorySyncErrors: Object.fromEntries(
        Object.entries(s.inventorySyncErrors).filter(([id]) => !ids.includes(id))
      )
    }))
    try {
      if (sourceId) await window.td.inventory.sync(sourceId)
      else await window.td.inventory.syncAll()
    } catch (err) {
      // Most failures are recorded on the source and shown in the tree, but the
      // ones raised before that point would otherwise vanish without a trace.
      const message = (err as Error).message || 'Sync failed'
      set((s) => ({
        inventorySyncErrors: {
          ...s.inventorySyncErrors,
          ...Object.fromEntries(ids.map((id) => [id, message]))
        }
      }))
    }
    set((s) => ({ inventorySyncing: s.inventorySyncing.filter((id) => !ids.includes(id)) }))
    await get().loadInventory()
  },

  saveInventorySource: async (source) => {
    await window.td.inventory.saveSource(source)
    await get().loadInventory()
    await get().syncInventory(source.id)
  },

  removeInventorySource: async (id) => {
    await window.td.inventory.removeSource(id)
    await get().loadInventory()
  },

  saveInventoryOverride: async (override, secret, gatewaySecret) => {
    await window.td.inventory.saveOverride(override, secret, gatewaySecret)
    await get().loadInventory()
  },

  clearInventoryOverride: async (nodeId) => {
    await window.td.inventory.clearOverride(nodeId)
    await get().loadInventory()
  }
})
