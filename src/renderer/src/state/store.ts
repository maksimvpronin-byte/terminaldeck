import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { loadSettings, saveSettings, type TerminalSettings } from './settings'
import { loadLayout, saveLayout } from './layout'
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
  type PaneNode,
  type PaneTarget
} from './paneTree'
import type {
  SessionGroup,
  SessionProfile,
  SessionStoreData,
  Snippet,
  InventorySource,
  InventoryOverride,
  InventoryTree
} from '../../../shared/types'

export type { PaneNode, PaneTarget }
export { collectConnectionIds, collectBroadcastTargets, collectLeaves } from './paneTree'

export interface WorkspaceTab {
  id: string
  title: string
  root: PaneNode
  activePaneId: string
}

interface AppState {
  groups: SessionGroup[]
  sessions: SessionProfile[]
  tabs: WorkspaceTab[]
  activeTabId: string | null
  vaultLocked: boolean
  /** When on, typing in any terminal is mirrored to every open pane, in every tab. */
  broadcast: boolean
  settings: TerminalSettings

  updateSettings: (patch: Partial<TerminalSettings>) => void

  lockVault: () => Promise<void>
  setVaultUnlocked: () => void
  loadStore: () => Promise<void>
  upsertSession: (session: SessionProfile, secret?: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  upsertGroup: (group: SessionGroup, secret?: string) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  moveSession: (sessionId: string, groupId: string | null) => Promise<void>
  moveGroup: (groupId: string, parentId: string | null) => Promise<void>

  inventorySources: InventorySource[]
  inventoryOverrides: InventoryOverride[]
  inventoryTrees: InventoryTree[]
  inventorySyncing: string[]
  gitAvailable: boolean
  loadInventory: () => Promise<void>
  syncInventory: (sourceId?: string) => Promise<void>
  saveInventorySource: (source: InventorySource) => Promise<void>
  removeInventorySource: (id: string) => Promise<void>
  saveInventoryOverride: (override: InventoryOverride) => Promise<void>
  clearInventoryOverride: (hostId: string) => Promise<void>

  snippets: Snippet[]
  loadSnippets: () => Promise<void>
  upsertSnippet: (snippet: Snippet) => Promise<void>
  removeSnippet: (id: string) => Promise<void>
  /** Sends text to the focused terminal, or to all broadcast targets when broadcast is on. */
  sendToTerminals: (text: string, execute: boolean) => number

  openTab: (title: string, target: PaneTarget, color?: string) => string
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  setActivePane: (tabId: string, paneId: string) => void
  setPaneConnection: (tabId: string, paneId: string, connectionId: string) => void
  splitPane: (tabId: string, paneId: string, dir: 'row' | 'col') => void
  splitPaneWith: (
    tabId: string,
    paneId: string,
    dir: 'row' | 'col',
    position: 'before' | 'after',
    title: string,
    target: PaneTarget,
    color?: string
  ) => void
  closePane: (tabId: string, paneId: string) => void
  /** Pulls a pane out of its split and gives it a tab of its own. */
  detachPane: (tabId: string, paneId: string) => void
  toggleSftp: (tabId: string, paneId: string) => void
  toggleTunnels: (tabId: string, paneId: string) => void
  toggleBroadcast: () => void
  togglePaneBroadcast: (tabId: string, paneId: string) => void
  setAllPanesBroadcast: (enabled: boolean) => void
  resizeSplit: (tabId: string, splitId: string, sizes: [number, number]) => void
}

const restoredLayout = loadLayout()

export const useStore = create<AppState>((set, get) => ({
  groups: [],
  sessions: [],
  tabs: restoredLayout.tabs,
  activeTabId: restoredLayout.activeTabId,
  vaultLocked: false,
  broadcast: false,
  settings: loadSettings(),

  updateSettings: (patch) =>
    set((s) => {
      const settings = { ...s.settings, ...patch }
      saveSettings(settings)
      return { settings }
    }),

  lockVault: async () => {
    await window.td.vault.lock()
    set({ vaultLocked: true })
  },

  setVaultUnlocked: () => set({ vaultLocked: false }),

  loadStore: async () => {
    const data: SessionStoreData = await window.td.store.load()
    set({ groups: data.groups, sessions: data.sessions })
  },

  upsertSession: async (session, secret) => {
    const saved = await window.td.store.saveSession(session, secret)
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === saved.id)
        ? s.sessions.map((x) => (x.id === saved.id ? saved : x))
        : [...s.sessions, saved]
    }))
  },

  removeSession: async (id) => {
    await window.td.store.deleteSession(id)
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
  },

  upsertGroup: async (group, secret) => {
    const saved = await window.td.store.saveGroup(group, secret)
    set((s) => ({
      groups: s.groups.some((x) => x.id === saved.id)
        ? s.groups.map((x) => (x.id === saved.id ? saved : x))
        : [...s.groups, saved]
    }))
  },

  removeGroup: async (id) => {
    await window.td.store.deleteGroup(id)
    set((s) => {
      // Mirror SessionStore.deleteGroup: children are adopted, not orphaned.
      const newParent = s.groups.find((g) => g.id === id)?.parentId ?? null
      return {
        groups: s.groups
          .filter((x) => x.id !== id)
          .map((g) => (g.parentId === id ? { ...g, parentId: newParent } : g)),
        sessions: s.sessions.map((x) => (x.groupId === id ? { ...x, groupId: newParent } : x))
      }
    })
  },

  moveSession: async (sessionId, groupId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session || session.groupId === groupId) return
    await get().upsertSession({ ...session, groupId, updatedAt: Date.now() })
  },

  moveGroup: async (groupId, parentId) => {
    const { groups } = get()
    const group = groups.find((g) => g.id === groupId)
    if (!group || group.parentId === parentId || groupId === parentId) return
    // Refuse to nest a group inside its own subtree — that would detach the branch.
    let cursor = parentId
    while (cursor) {
      if (cursor === groupId) return
      cursor = groups.find((g) => g.id === cursor)?.parentId ?? null
    }
    await get().upsertGroup({ ...group, parentId })
  },

  inventorySources: [],
  inventoryOverrides: [],
  inventoryTrees: [],
  inventorySyncing: [],
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
    set((s) => ({ inventorySyncing: [...s.inventorySyncing, ...ids] }))
    try {
      if (sourceId) await window.td.inventory.sync(sourceId)
      else await window.td.inventory.syncAll()
    } catch {
      // The error is recorded on the source itself and shown in the tree.
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

  saveInventoryOverride: async (override) => {
    await window.td.inventory.saveOverride(override)
    await get().loadInventory()
  },

  clearInventoryOverride: async (hostId) => {
    await window.td.inventory.clearOverride(hostId)
    await get().loadInventory()
  },

  snippets: [],

  loadSnippets: async () => {
    set({ snippets: await window.td.snippets.list() })
  },

  upsertSnippet: async (snippet) => {
    const saved = await window.td.snippets.save(snippet)
    set((s) => ({
      snippets: s.snippets.some((x) => x.id === saved.id)
        ? s.snippets.map((x) => (x.id === saved.id ? saved : x))
        : [...s.snippets, saved]
    }))
  },

  removeSnippet: async (id) => {
    await window.td.snippets.remove(id)
    set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id) }))
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
  },

  openTab: (title, target, color) => {
    const leaf = makeLeaf(title, target, color)
    const tab: WorkspaceTab = { id: nanoid(), title, root: leaf, activePaneId: leaf.id }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }))
    return leaf.id
  },

  closeTab: (tabId) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== tabId)
      const activeTabId = s.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

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
          ? { ...t, root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, sftpOpen: !leaf.sftpOpen })) }
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
              root: mapPane(t.root, paneId, (leaf) => ({ ...leaf, tunnelsOpen: !leaf.tunnelsOpen }))
            }
          : t
      )
    }))
  },

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

  resizeSplit: (tabId, splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, root: setSizes(t.root, splitId, sizes) } : t))
    }))
  }
}))

// Persist the workspace shape whenever it changes, so a restart brings the tabs
// and splits back. Connections themselves are not restored — see layout.ts.
let lastTabs = useStore.getState().tabs
let lastActive = useStore.getState().activeTabId
useStore.subscribe((state) => {
  if (state.tabs === lastTabs && state.activeTabId === lastActive) return
  lastTabs = state.tabs
  lastActive = state.activeTabId
  saveLayout(state.tabs, state.activeTabId)
})
