import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import { allTabs } from '../workspaces'
import { paneNodeOf, savedPaneOf } from '../multiWindow'
import type { AppState, MultiWindowsSlice } from './types'

export const createMultiWindowsSlice: StateCreator<AppState, [], [], MultiWindowsSlice> = (
  set,
  get
) => ({
  multiWindows: [],
  multiWindowDraft: null,
  draftMultiWindow: (draft) => set({ multiWindowDraft: draft }),

  loadMultiWindows: async () => {
    set({ multiWindows: await window.td.multiWindows.list() })
  },

  saveTabAsMultiWindow: async (tabId, name, replaceId) => {
    const tab = allTabs(get()).find((t) => t.id === tabId)
    const root = tab && savedPaneOf(tab.root)
    // A tab of nothing but Quick connect panes has no saved host to keep.
    if (!root) return false
    const now = Date.now()
    const previous = get().multiWindows.find((w) => w.id === replaceId)
    await window.td.multiWindows.save({
      id: previous?.id ?? nanoid(),
      name: name.trim() || previous?.name || tab.title,
      root,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    })
    await get().loadMultiWindows()
    return true
  },

  renameMultiWindow: async (id, name) => {
    const window_ = get().multiWindows.find((w) => w.id === id)
    if (!window_ || !name.trim()) return
    await window.td.multiWindows.save({ ...window_, name: name.trim(), updatedAt: Date.now() })
    await get().loadMultiWindows()
  },

  removeMultiWindow: async (id) => {
    await window.td.multiWindows.remove(id)
    await get().loadMultiWindows()
  },

  moveMultiWindow: async (id, delta) => {
    const order = get().multiWindows.map((w) => w.id)
    const from = order.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= order.length) return
    order.splice(to, 0, ...order.splice(from, 1))
    await window.td.multiWindows.reorder(order)
    await get().loadMultiWindows()
  },

  openMultiWindow: (id) => {
    const saved = get().multiWindows.find((w) => w.id === id)
    if (!saved) return
    get().openPanes(saved.name, paneNodeOf(saved.root))
    // The keyboard goes to it, as to a host opened from the tree.
    get().focusActivePane()
  }
})
