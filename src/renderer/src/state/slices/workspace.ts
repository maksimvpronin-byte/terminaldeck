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
  collectBroadcastTargets,
  type PaneTarget
} from '../paneTree'
import { activeTab, allTabs, mapTab, workspaceOfTab } from '../workspaces'
import { loadLayout } from '../layout'
import type { AppState, OpenRequest, Workspace, WorkspaceSlice, WorkspaceTab } from './types'

const restored = loadLayout()

function makeTab(
  title: string,
  target: PaneTarget,
  color?: string,
  viaCollectionId?: string
): WorkspaceTab {
  const leaf = makeLeaf(title, target, color, viaCollectionId)
  return { id: nanoid(), title, root: leaf, activePaneId: leaf.id }
}

/** "Workspace 3" — the lowest number not already on the strip. */
function nextTitle(workspaces: Workspace[]): string {
  const taken = new Set(workspaces.map((w) => w.title))
  for (let n = 1; ; n++) {
    const candidate = `Workspace ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

export const createWorkspaceSlice: StateCreator<AppState, [], [], WorkspaceSlice> = (set, get) => ({
  workspaces: restored.workspaces,
  activeWorkspaceId: restored.activeWorkspaceId,
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

  // --- workspaces (the top strip) ---

  openWorkspace: (title, color) => {
    const workspace: Workspace = {
      id: nanoid(),
      title: title?.trim() || nextTitle(get().workspaces),
      color,
      tabs: [],
      activeTabId: null
    }
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id
    }))
    return workspace.id
  },

  closeWorkspace: (workspaceId) => {
    set((s) => {
      const workspaces = s.workspaces.filter((w) => w.id !== workspaceId)
      const activeWorkspaceId =
        s.activeWorkspaceId === workspaceId
          ? (workspaces[workspaces.length - 1]?.id ?? null)
          : s.activeWorkspaceId
      return { workspaces, activeWorkspaceId }
    })
  },

  setActiveWorkspace: (workspaceId) => set({ activeWorkspaceId: workspaceId }),

  renameWorkspace: (workspaceId, title) => {
    const trimmed = title.trim()
    if (!trimmed) return
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === workspaceId ? { ...w, title: trimmed } : w))
    }))
  },

  moveTabToWorkspace: (tabId, workspaceId) => {
    set((s) => {
      const from = workspaceOfTab(s, tabId)
      if (!from || from.id === workspaceId) return {}
      const tab = from.tabs.find((t) => t.id === tabId)
      if (!tab) return {}

      // The tab object is carried across untouched, and every tab panel is
      // rendered from one flat list keyed by tab id — so React never remounts
      // it and the SSH session survives the move.
      const workspaces = s.workspaces.map((w) => {
        if (w.id === from.id) {
          const tabs = w.tabs.filter((t) => t.id !== tabId)
          return {
            ...w,
            tabs,
            activeTabId:
              w.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : w.activeTabId
          }
        }
        if (w.id === workspaceId) return { ...w, tabs: [...w.tabs, tab], activeTabId: tabId }
        return w
      })
      return { workspaces, activeWorkspaceId: workspaceId }
    })
  },

  // --- tabs ---

  openTab: (title, target, color, viaCollectionId) => {
    // A tab always needs somewhere to live; the first one makes its workspace.
    if (!get().workspaces.some((w) => w.id === get().activeWorkspaceId)) get().openWorkspace()
    const tab = makeTab(title, target, color, viaCollectionId)
    const workspaceId = get().activeWorkspaceId
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id } : w
      )
    }))
    return tab.activePaneId
  },

  openMany: (items, mode, workspaceTitle) => {
    if (items.length === 0) return
    if (mode === 'workspace') {
      // The group's own colour rides along, so the whole strip entry is tinted.
      get().openWorkspace(workspaceTitle, items.find((i) => i.color)?.color)
      for (const item of items) {
        get().openTab(item.title, item.target, item.color, item.viaCollectionId)
      }
      return
    }
    if (mode === 'tabs') {
      for (const item of items) {
        get().openTab(item.title, item.target, item.color, item.viaCollectionId)
      }
      return
    }

    const [first, ...rest] = items
    get().openTab(first.title, first.target, first.color, first.viaCollectionId)
    const tabId = activeTab(get())?.id
    if (!tabId) return
    rest.forEach((item, index) => {
      const tab = allTabs(get()).find((t) => t.id === tabId)
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
      const owner = workspaceOfTab(s, tabId)
      if (!owner) return {}
      const tabs = owner.tabs.filter((t) => t.id !== tabId)

      // Closing the last tab retires the workspace with it, the way a browser
      // window goes when its last tab does — unless it is the only workspace
      // left, where an empty strip is less jarring than everything vanishing.
      if (tabs.length === 0 && s.workspaces.length > 1) {
        const workspaces = s.workspaces.filter((w) => w.id !== owner.id)
        return {
          workspaces,
          activeWorkspaceId:
            s.activeWorkspaceId === owner.id
              ? (workspaces[workspaces.length - 1]?.id ?? null)
              : s.activeWorkspaceId
        }
      }

      return {
        workspaces: s.workspaces.map((w) =>
          w.id === owner.id
            ? {
                ...w,
                tabs,
                activeTabId:
                  w.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : w.activeTabId
              }
            : w
        )
      }
    })
  },

  setActiveTab: (tabId) => {
    set((s) => {
      const owner = workspaceOfTab(s, tabId)
      if (!owner) return {}
      return {
        // Looking at a tab brings its workspace forward too, so this one call
        // works from the host palette, which does not know where a tab lives.
        activeWorkspaceId: owner.id,
        workspaces: s.workspaces.map((w) =>
          w.id === owner.id
            ? {
                ...w,
                activeTabId: tabId,
                tabs: w.tabs.map((t) => (t.id === tabId ? { ...t, hasActivity: false } : t))
              }
            : w
        )
      }
    })
  },

  markActivity: (tabId) => {
    set((s) => {
      if (activeTab(s)?.id === tabId) return {}
      const tab = allTabs(s).find((t) => t.id === tabId)
      if (!tab || tab.hasActivity) return {}
      return { workspaces: mapTab(s.workspaces, tabId, (t) => ({ ...t, hasActivity: true })) }
    })
  },

  // --- panes ---

  setActivePane: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({ ...t, activePaneId: paneId }))
    }))
  },

  setPaneConnection: (tabId, paneId, connectionId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, connectionId }))
      }))
    }))
  },

  splitPane: (tabId, paneId, dir) => {
    const tab = allTabs(get()).find((t) => t.id === tabId)
    const source = findPane(tab?.root ?? null, paneId)
    if (!source || source.type !== 'leaf') return
    get().splitPaneWith(tabId, paneId, dir, 'after', source.title, source.target, source.color)
  },

  splitPaneWith: (tabId, paneId, dir, position, title, target, color) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => {
        const newLeaf = makeLeaf(title, target, color)
        const root = splitLeaf(t.root, paneId, dir, position, newLeaf)
        return root ? { ...t, root, activePaneId: newLeaf.id } : t
      })
    }))
  },

  closePane: (tabId, paneId) => {
    const tab = allTabs(get()).find((t) => t.id === tabId)
    if (!tab) return
    const root = removePane(tab.root, paneId)
    // That was the tab's last pane, so the tab goes — and perhaps its workspace.
    if (!root) {
      get().closeTab(tabId)
      return
    }
    const leaves = collectLeaves(root)
    const activePaneId = leaves.some((l) => l.id === tab.activePaneId)
      ? tab.activePaneId
      : leaves[0].id
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({ ...t, root, activePaneId }))
    }))
  },

  detachPane: (tabId, paneId) => {
    set((s) => {
      const owner = workspaceOfTab(s, tabId)
      const tab = owner?.tabs.find((t) => t.id === tabId)
      if (!owner || !tab) return {}
      const leaf = collectLeaves(tab.root).find((l) => l.id === paneId)
      // Nothing to detach from when the pane already owns the whole tab.
      if (!leaf || tab.root.type === 'leaf') return {}
      const remaining = removePane(tab.root, paneId)
      if (!remaining) return {}

      // The pane moves to a different tree, so React remounts it and the old
      // connection is torn down; the new one starts fresh.
      const moved = makeTab(leaf.title, leaf.target, leaf.color)
      const leaves = collectLeaves(remaining)
      return {
        workspaces: s.workspaces.map((w) =>
          w.id === owner.id
            ? {
                ...w,
                tabs: [
                  ...w.tabs.map((t) =>
                    t.id === tabId
                      ? {
                          ...t,
                          root: remaining,
                          activePaneId: leaves.some((l) => l.id === t.activePaneId)
                            ? t.activePaneId
                            : leaves[0].id
                        }
                      : t
                  ),
                  moved
                ],
                activeTabId: moved.id
              }
            : w
        )
      }
    })
  },

  toggleSftp: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, sftpOpen: !leaf.sftpOpen }))
      }))
    }))
  },

  toggleTunnels: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, tunnelsOpen: !leaf.tunnelsOpen }))
      }))
    }))
  },

  resizeSplit: (tabId, splitId, sizes) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: setSizes(t.root, splitId, sizes)
      }))
    }))
  },

  // --- broadcast ---

  toggleBroadcast: () => set((s) => ({ broadcast: !s.broadcast })),

  togglePaneBroadcast: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({
          ...leaf,
          broadcastEnabled: !leaf.broadcastEnabled
        }))
      }))
    }))
  },

  setAllPanesBroadcast: (enabled) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => ({
        ...w,
        tabs: w.tabs.map((t) => ({ ...t, root: setAllBroadcast(t.root, enabled) }))
      }))
    }))
  },

  sendToTerminals: (text, execute) => {
    const s = get()
    const tab = activeTab(s)
    if (!tab) return 0
    const own = collectLeaves(tab.root).find((l) => l.id === tab.activePaneId)?.connectionId
    const targets = s.broadcast
      ? allTabs(s).flatMap((t) => collectBroadcastTargets(t.root))
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
