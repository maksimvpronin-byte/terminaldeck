import type { StateCreator } from 'zustand'
import { nanoid } from 'nanoid'
import {
  makeLeaf,
  mapPane,
  findPane,
  removePane,
  setSizes,
  splitLeaf,
  copyTree,
  setAllBroadcast,
  collectLeaves,
  collectBroadcastTargets,
  type PaneTarget
} from '../paneTree'
import {
  activeTab,
  allTabs,
  mapTab,
  nextOpenPaneOf,
  paneToReuse,
  workspaceOfTab
} from '../workspaces'
import { loadLayout } from '../layout'
import { findHost, hostColour } from '../hosts'
import { protocolOf } from '../../../../shared/protocols'
import { colourOf } from '../../../../shared/hostColour'
import type {
  AppState,
  OpenRequest,
  Workspace,
  WorkspaceOwner,
  WorkspaceSlice,
  WorkspaceTab
} from './types'

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

/** The host a pane is for, if it is for a saved or inventory host at all. */
function sessionOf(target: PaneTarget): string | undefined {
  return target.kind === 'session' ? target.sessionId : undefined
}

/**
 * Brings forward the workspace hosts opened from the tree belong in, making
 * one if there is none — never a collection's, which holds the set and only
 * the set: saved again as the collection, it would take a stranger in with it.
 *
 * With `workspacePerGroup` on, hosts that share a group go into that group's
 * workspace, named after it. Everything else — the setting off, a host at the
 * top of the tree, hosts from different groups opened together — goes to an
 * ordinary workspace: the one in front if it is one, else the last on the
 * strip, else a new one.
 */
function homeWorkspace(get: () => AppState, sessionIds: (string | undefined)[]): void {
  const s = get()
  const perGroup = s.settings.workspacePerGroup
  if (perGroup && sessionIds.length > 0) {
    const found = sessionIds.map((id) => (id ? findHost(s, id) : undefined))
    const groupId = found[0]?.host.groupId
    const group =
      groupId && found.every((f) => f?.host.groupId === groupId)
        ? found[0]?.groups.find((g) => g.id === groupId)
        : undefined
    if (group && found[0]) {
      const own = s.workspaces.find((w) => w.groupId === group.id)
      if (own) s.setActiveWorkspace(own.id)
      else
        s.openWorkspace(group.name, colourOf(group, group.parentId, found[0].groups), {
          groupId: group.id
        })
      return
    }
  }
  // A group's workspace is an ordinary one again once the setting is off.
  const ordinary = (w: Workspace): boolean => !w.collectionId && !(perGroup && w.groupId)
  if (s.workspaces.some((w) => w.id === s.activeWorkspaceId && ordinary(w))) return
  const last = [...s.workspaces].reverse().find(ordinary)
  if (last) s.setActiveWorkspace(last.id)
  else s.openWorkspace()
}

/** Marks `id` as the owner's workspace, and no other one as it: one each. */
function claim(workspaces: Workspace[], id: string, owner: WorkspaceOwner): Workspace[] {
  const collectionId = 'collectionId' in owner ? owner.collectionId : undefined
  const groupId = 'groupId' in owner ? owner.groupId : undefined
  return workspaces.map((w) => {
    if (w.id === id) return { ...w, collectionId, groupId }
    if (collectionId && w.collectionId === collectionId) return { ...w, collectionId: undefined }
    if (groupId && w.groupId === groupId) return { ...w, groupId: undefined }
    return w
  })
}

export const createWorkspaceSlice: StateCreator<AppState, [], [], WorkspaceSlice> = (set, get) => ({
  workspaces: restored.workspaces,
  activeWorkspaceId: restored.activeWorkspaceId,
  broadcast: false,
  selectedHostIds: [],
  lastSelectedHostId: null,
  focusRequest: 0,
  wakeRequest: null,
  hostMenuRequest: null,

  // --- selecting hosts in the tree ---

  toggleHostSelection: (id) =>
    set((s) => ({
      selectedHostIds: s.selectedHostIds.includes(id)
        ? s.selectedHostIds.filter((x) => x !== id)
        : [...s.selectedHostIds, id],
      lastSelectedHostId: id
    })),

  selectOnlyHost: (id) => set({ selectedHostIds: [id], lastSelectedHostId: id }),

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
      // Saved, from an Inventory source, or mirrored into a folder from git —
      // whichever it is, it wears the colour its row in the tree wears.
      const found = findHost(s, id)
      if (!found) continue
      items.push({
        title: found.host.name,
        target: { kind: 'session', sessionId: id },
        color: hostColour(s, id)
      })
    }

    get().openMany(items, mode)
    get().clearHostSelection()
  },

  // --- workspaces (the top strip) ---

  openWorkspace: (title, color, owner) => {
    const workspace: Workspace = {
      id: nanoid(),
      title: title?.trim() || nextTitle(get().workspaces),
      color,
      tabs: [],
      activeTabId: null
    }
    set((s) => {
      const workspaces = [...s.workspaces, workspace]
      // One workspace per collection or group: the newest is where its hosts go.
      return {
        workspaces: owner ? claim(workspaces, workspace.id, owner) : workspaces,
        activeWorkspaceId: workspace.id
      }
    })
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

  setWorkspaceCollection: (workspaceId, collectionId) =>
    // One workspace per collection, so a host knows where to go.
    set((s) => ({ workspaces: claim(s.workspaces, workspaceId, { collectionId }) })),

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
      if (!from || from.id === workspaceId || !s.workspaces.some((w) => w.id === workspaceId))
        return {}
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

  reorderTab: (tabId, targetId, place) => {
    set((s) => {
      if (tabId === targetId) return {}
      const owner = workspaceOfTab(s, tabId)
      const tab = owner?.tabs.find((t) => t.id === tabId)
      // Only within one strip: a tab goes to another workspace by its header.
      if (!owner || !tab || !owner.tabs.some((t) => t.id === targetId)) return {}
      const rest = owner.tabs.filter((t) => t.id !== tabId)
      const at = rest.findIndex((t) => t.id === targetId) + (place === 'after' ? 1 : 0)
      const tabs = [...rest.slice(0, at), tab, ...rest.slice(at)]
      if (tabs.every((t, i) => t === owner.tabs[i])) return {}
      // Same tab objects, same keys — the panels stay mounted and connected.
      return {
        workspaces: s.workspaces.map((w) => (w.id === owner.id ? { ...w, tabs } : w))
      }
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

  openHost: (title, target, color, viaCollectionId, again = false) => {
    const s = get()
    if (target.kind === 'session') {
      const desktop = protocolOf(findHost(s, target.sessionId)?.host) === 'rdp'
      const account = target.credentialId !== undefined || target.admin === true
      const reuse = desktop || (!again && !account && s.settings.reuseOpenHost)
      const place =
        reuse &&
        paneToReuse(
          s,
          target.sessionId,
          desktop ? { credentialId: target.credentialId } : undefined
        )
      if (place) {
        get().setActiveTab(place.tabId)
        get().setActivePane(place.tabId, place.paneId)
        get().focusActivePane()
        set((st) => ({
          wakeRequest: { paneId: place.paneId, n: (st.wakeRequest?.n ?? 0) + 1 }
        }))
        return place.paneId
      }
    }
    // Opened from a set, it goes where that set is open, not into whatever
    // workspace happens to be in front. A duplicate stays beside its original.
    const collection =
      viaCollectionId && !again ? s.collections.find((c) => c.id === viaCollectionId) : undefined
    if (collection) {
      const own = s.workspaces.find((w) => w.collectionId === collection.id)
      if (own) get().setActiveWorkspace(own.id)
      else get().openWorkspace(collection.name, color, { collectionId: collection.id })
    } else if (!again) {
      homeWorkspace(get, [sessionOf(target)])
    }
    return get().openTab(title, target, color, viaCollectionId)
  },

  requestHostMenu: (request) => set({ hostMenuRequest: request }),

  openPanes: (title, root) => {
    if (!get().workspaces.some((w) => w.id === get().activeWorkspaceId)) get().openWorkspace()
    const first = collectLeaves(root)[0]
    const tab: WorkspaceTab = { id: nanoid(), title, root, activePaneId: first.id }
    const workspaceId = get().activeWorkspaceId
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id } : w
      )
    }))
    return tab.id
  },

  openMany: (items, mode, workspaceTitle, owner) => {
    if (items.length === 0) return
    if (mode === 'workspace') {
      // The group's own colour rides along, so the whole strip entry is tinted.
      get().openWorkspace(workspaceTitle, items.find((i) => i.color)?.color, owner)
      for (const item of items) {
        get().openTab(item.title, item.target, item.color, item.viaCollectionId)
      }
      return
    }
    if (mode === 'tabs') {
      for (const item of items) {
        // Each to its own place: with a workspace per group, hosts picked from
        // two groups go to two workspaces.
        if (!item.viaCollectionId) homeWorkspace(get, [sessionOf(item.target)])
        get().openTab(item.title, item.target, item.color, item.viaCollectionId)
      }
      return
    }

    const [first, ...rest] = items
    // One tab holds them all, so it goes where they all belong, if they agree.
    if (!items.some((i) => i.viaCollectionId))
      homeWorkspace(
        get,
        items.map((i) => sessionOf(i.target))
      )
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
        item.color,
        // Every pane of a collection opened as a grid wears its look, not the
        // first alone.
        item.viaCollectionId
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
      if (activeTab(s)?.id === tabId) return s
      const tab = allTabs(s).find((t) => t.id === tabId)
      if (!tab || tab.hasActivity) return s
      return { workspaces: mapTab(s.workspaces, tabId, (t) => ({ ...t, hasActivity: true })) }
    })
  },

  // --- panes ---

  setActivePane: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({ ...t, activePaneId: paneId }))
    }))
  },

  focusActivePane: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),

  revealSession: (sessionId) => {
    const place = nextOpenPaneOf(get(), sessionId)
    if (!place) return false
    get().setActiveTab(place.tabId)
    get().setActivePane(place.tabId, place.paneId)
    // Every caller is a click on a host, so the keyboard follows the eye.
    get().focusActivePane()
    return true
  },

  setPaneConnection: (tabId, paneId, connectionId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, connectionId }))
      }))
    }))
  },

  setPaneDesktop: (tabId, paneId, desktopId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, desktopId }))
      }))
    }))
  },

  splitPane: (tabId, paneId, dir) => {
    const tab = allTabs(get()).find((t) => t.id === tabId)
    const source = findPane(tab?.root ?? null, paneId)
    if (!source || source.type !== 'leaf') return
    get().splitPaneWith(
      tabId,
      paneId,
      dir,
      'after',
      source.title,
      source.target,
      source.color,
      source.viaCollectionId
    )
  },

  splitPaneWith: (tabId, paneId, dir, position, title, target, color, viaCollectionId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => {
        const newLeaf = makeLeaf(title, target, color, viaCollectionId)
        const root = splitLeaf(t.root, paneId, dir, position, newLeaf)
        return root ? { ...t, root, activePaneId: newLeaf.id } : t
      })
    }))
  },

  mergeTabInto: (sourceTabId, targetTabId, paneId, dir, position) => {
    if (sourceTabId === targetTabId) return
    const tabs = allTabs(get())
    const source = tabs.find((t) => t.id === sourceTabId)
    const target = tabs.find((t) => t.id === targetTabId)
    if (!source || !target) return
    /*
     * The whole tree, not its first pane. Only the first was copied here and
     * then the tab it came from was closed, so every other pane in a split tab
     * vanished with it, and its session was closed.
     */
    const ids = new Map<string, string>()
    const moved = copyTree(source.root, ids)
    const root = splitLeaf(target.root, paneId, dir, position, moved)
    if (!root) return
    const activePaneId = ids.get(source.activePaneId) ?? collectLeaves(moved)[0].id
    set((s) => ({
      workspaces: mapTab(s.workspaces, targetTabId, (t) => ({ ...t, root, activePaneId }))
    }))
    get().closeTab(sourceTabId)
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
      const moved = makeTab(leaf.title, leaf.target, leaf.color, leaf.viaCollectionId)
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

  toggleMonitor: (tabId, paneId) => {
    set((s) => ({
      workspaces: mapTab(s.workspaces, tabId, (t) => ({
        ...t,
        // With the monitor on everywhere, the toggle closes or reopens it for
        // this pane alone; otherwise it is the pane's own switch, as before.
        root: mapPane(t.root, paneId, (leaf) =>
          s.settings.monitorForAll
            ? { ...leaf, monitorClosed: !leaf.monitorClosed }
            : { ...leaf, monitorOpen: !leaf.monitorOpen }
        )
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
