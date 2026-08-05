import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import {
  makeLeaf,
  mapPane,
  findPane,
  removePane,
  setSizes,
  splitLeaf,
  setAllBroadcast,
  collectLeaves,
  collectBroadcastTargets
} from '../paneTree'
import { loadLayout } from '../layout'
import type { AppState, OpenRequest, WorkspaceSlice, WorkspaceTab } from './types'

const restored = loadLayout()

export const createWorkspaceSlice: StateCreator<AppState, [], [], WorkspaceSlice> = (set, get) => ({
  tabs: restored.tabs,
  activeTabId: restored.activeTabId,
  broadcast: false,
  selectedHostIds: [],
  lastSelectedHostId: null,

  // --- selecting hosts in the tree ---

  toggleHostSelection: (id) =>
    set((s) => ({
      selectedHostIds: s.selectedHostIds.includes(id)
        ? s.selectedHostIds.filter((x) => x !== id)
        : [...s.selectedHostIds, id],
      lastSelectedHostId: id
    })),

  selectHostRange: (orderedIds, toId) =>
    set((s) => {
      const to = orderedIds.indexOf(toId)
      if (to < 0) return {}
      const anchor = s.lastSelectedHostId ? orderedIds.indexOf(s.lastSelectedHostId) : -1
      const from = anchor >= 0 ? anchor : to
      const [lo, hi] = from < to ? [from, to] : [to, from]
      return {
        selectedHostIds: [...new Set([...s.selectedHostIds, ...orderedIds.slice(lo, hi + 1)])],
        lastSelectedHostId: toId
      }
    }),

  clearHostSelection: () => set({ selectedHostIds: [], lastSelectedHostId: null }),

  openSelectedHosts: (mode) => {
    const s = get()
    const items: OpenRequest[] = []

    for (const id of s.selectedHostIds) {
      const manual = s.sessions.find((x) => x.id === id)
      if (manual) {
        items.push({
          title: manual.name,
          target: { kind: 'session', sessionId: id },
          color: manual.color
        })
        continue
      }
      // Otherwise it came from an inventory; its colour may be overridden locally.
      for (const tree of s.inventoryTrees) {
        const host = tree.sessions.find((x) => x.id === id)
        if (!host) continue
        const override = s.inventoryOverrides.find((o) => o.nodeId === id)
        items.push({
          title: host.name,
          target: { kind: 'session', sessionId: id },
          color: override?.color ?? host.color
        })
        break
      }
    }

    get().openMany(items, mode)
    get().clearHostSelection()
  },

  // --- tabs ---

  openTab: (title, target, color) => {
    const leaf = makeLeaf(title, target, color)
    const tab: WorkspaceTab = { id: nanoid(), title, root: leaf, activePaneId: leaf.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    return leaf.id
  },

  openMany: (items, mode) => {
    if (items.length === 0) return
    if (mode === 'tabs') {
      for (const item of items) get().openTab(item.title, item.target, item.color)
      return
    }

    const [first, ...rest] = items
    get().openTab(first.title, first.target, first.color)
    const tabId = get().tabs[get().tabs.length - 1].id
    rest.forEach((item, index) => {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      // Alternate the direction so the panes stay roughly square rather than
      // ending up as a row of slivers.
      get().splitPaneWith(
        tabId,
        tab.activePaneId,
        index % 2 === 0 ? 'row' : 'col',
        'after',
        item.title,
        item.target,
        item.color
      )
    })
  },

  closeTab: (tabId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId =
        s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (tabId) =>
    set((s) => ({
      activeTabId: tabId,
      // Looking at a tab clears its unread marker.
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasActivity: false } : t))
    })),

  markActivity: (tabId) => {
    set((s) => {
      if (s.activeTabId === tabId) return {}
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab || tab.hasActivity) return {}
      return { tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, hasActivity: true } : t)) }
    })
  },

  // --- panes ---

  setActivePane: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t))
    }))
  },

  setPaneConnection: (tabId, paneId, connectionId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, connectionId })) }
          : t
      )
    }))
  },

  splitPane: (tabId, paneId, dir) => {
    const source = findPane(get().tabs.find((t) => t.id === tabId)?.root ?? null, paneId)
    if (!source || source.type !== 'leaf') return
    get().splitPaneWith(tabId, paneId, dir, 'after', source.title, source.target, source.color)
  },

  splitPaneWith: (tabId, paneId, dir, position, title, target, color) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const newLeaf = makeLeaf(title, target, color)
        const root = splitLeaf(t.root, paneId, dir, position, newLeaf)
        return root ? { ...t, root, activePaneId: newLeaf.id } : t
      })
    }))
  },

  closePane: (tabId, paneId) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      const root = removePane(tab.root, paneId)
      if (!root) {
        // That was the tab's last pane — drop the tab along with it.
        const tabs = s.tabs.filter((t) => t.id !== tabId)
        return {
          tabs,
          activeTabId:
            s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
        }
      }
      const leaves = collectLeaves(root)
      const activePaneId = leaves.some((l) => l.id === tab.activePaneId)
        ? tab.activePaneId
        : leaves[0].id
      return {
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, root, activePaneId } : t))
      }
    })
  },

  detachPane: (tabId, paneId) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      // Nothing to detach from when the pane already owns the whole tab.
      if (!leaf || tab.root.type === 'leaf') return {}
      const remaining = removePane(tab.root, paneId)
      if (!remaining) return {}

      // The pane moves to a different tree, so React remounts it and the old
      // connection is torn down; the new one starts fresh.
      const moved = makeLeaf(leaf.title, leaf.target, leaf.color)
      const newTab: WorkspaceTab = {
        id: nanoid(),
        title: leaf.title,
        root: moved,
        activePaneId: moved.id
      }
      const leaves = collectLeaves(remaining)
      const updated = s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: remaining,
              activePaneId: leaves.some((l) => l.id === t.activePaneId)
                ? t.activePaneId
                : leaves[0].id
            }
          : t
      )
      return { tabs: [...updated, newTab], activeTabId: newTab.id }
    })
  },

  toggleSftp: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, sftpOpen: !leaf.sftpOpen }))
            }
          : t
      )
    }))
  },

  toggleTunnels: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: mapPane(t.root, paneId, (leaf) => ({
                ...leaf,
                tunnelsOpen: !leaf.tunnelsOpen
              }))
            }
          : t
      )
    }))
  },

  resizeSplit: (tabId, splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, root: setSizes(t.root, splitId, sizes) } : t
      )
    }))
  },

  // --- broadcast ---

  toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),

  togglePaneBroadcast: (tabId, paneId) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              root: mapPane(t.root, paneId, (leaf) => ({
                ...leaf,
                broadcastEnabled: !leaf.broadcastEnabled
              }))
            }
          : t
      )
    }))
  },

  setAllPanesBroadcast: (enabled) => {
    set((s) => ({ tabs: s.tabs.map((t) => ({ ...t, root: setAllBroadcast(t.root, enabled) })) }))
  },

  sendToTerminals: (text, execute) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return 0
    const own = collectLeaves(tab.root).find((l) => l.id === tab.activePaneId)?.connectionId
    const targets = s.broadcast
      ? s.tabs.flatMap((t) => collectBroadcastTargets(t.root))
      : own
        ? [own]
        : []
    // Trailing newline is what actually runs the command; without it the text
    // just lands on the prompt for the user to review.
    const payload = execute ? (text.endsWith('\n') ? text : `${text}\n`) : text
    for (const cid of targets) window.td.ssh.write(cid, payload)
    return targets.length
  }
})
