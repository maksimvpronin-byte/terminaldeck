import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import { allTabs, openDesktop } from '../workspaces'
import { collectLeaves, removePane, type PaneNode } from '../paneTree'
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
    /*
     * A desktop already open for its account stays where it is, woken if it
     * waits, and the layout opens without it: opened as saved, it was a
     * second session that Windows signed the first one out for, and each
     * opening of the layout added another.
     */
    let root: PaneNode | null = paneNodeOf(saved.root)
    let first: { tabId: string; paneId: string } | undefined
    for (const leaf of collectLeaves(root)) {
      const place = openDesktop(get(), leaf.target)
      if (!place || !root) continue
      first ??= place
      get().wakePane(place.paneId, false)
      root = removePane(root, leaf.id)
    }
    if (root) get().openPanes(saved.name, root)
    else if (first) {
      get().setActiveTab(first.tabId)
      get().setActivePane(first.tabId, first.paneId)
    }
    // The keyboard goes to it, as to a host opened from the tree.
    get().focusActivePane()
  }
})
