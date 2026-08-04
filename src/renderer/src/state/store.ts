import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { loadSettings, saveSettings, type TerminalSettings } from './settings'
import type {
  SessionGroup,
  SessionProfile,
  SessionStoreData,
  QuickConnectParams
} from '../../../shared/types'

export type PaneTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'quick'; params: QuickConnectParams }

export type PaneNode =
  | {
      type: 'leaf'
      id: string
      title: string
      target: PaneTarget
      connectionId?: string
      sftpOpen: boolean
      tunnelsOpen: boolean
      /** Whether this terminal takes part in broadcast input. */
      broadcastEnabled: boolean
    }
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: [PaneNode, PaneNode]; sizes: [number, number] }

export interface WorkspaceTab {
  id: string
  title: string
  root: PaneNode
  activePaneId: string
}

/** Connection ids of every connected pane in a tab. */
export function collectConnectionIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return node.connectionId ? [node.connectionId] : []
  return [...collectConnectionIds(node.children[0]), ...collectConnectionIds(node.children[1])]
}

/** Connection ids of panes opted in to broadcast. */
export function collectBroadcastTargets(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    return node.connectionId && node.broadcastEnabled ? [node.connectionId] : []
  }
  return [
    ...collectBroadcastTargets(node.children[0]),
    ...collectBroadcastTargets(node.children[1])
  ]
}

/** Every leaf in a tab, regardless of connection state. */
export function collectLeaves(node: PaneNode): Array<Extract<PaneNode, { type: 'leaf' }>> {
  if (node.type === 'leaf') return [node]
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])]
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
  upsertGroup: (group: SessionGroup) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  moveSession: (sessionId: string, groupId: string | null) => Promise<void>
  moveGroup: (groupId: string, parentId: string | null) => Promise<void>

  openTab: (title: string, target: PaneTarget) => string
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
    target: PaneTarget
  ) => void
  closePane: (tabId: string, paneId: string) => void
  toggleSftp: (tabId: string, paneId: string) => void
  toggleTunnels: (tabId: string, paneId: string) => void
  toggleBroadcast: () => void
  togglePaneBroadcast: (tabId: string, paneId: string) => void
  setAllPanesBroadcast: (enabled: boolean) => void
  resizeSplit: (tabId: string, splitId: string, sizes: [number, number]) => void
}

function makeLeaf(title: string, target: PaneTarget): PaneNode {
  return {
    type: 'leaf',
    id: nanoid(),
    connectionId: undefined,
    title,
    target,
    sftpOpen: false,
    tunnelsOpen: false,
    broadcastEnabled: true
  }
}

type LeafNode = Extract<PaneNode, { type: 'leaf' }>

function mapPane(node: PaneNode, id: string, fn: (leaf: LeafNode) => LeafNode): PaneNode {
  if (node.type === 'leaf') return node.id === id ? fn(node) : node
  if (node.id === id) return node
  return {
    ...node,
    children: [mapPane(node.children[0], id, fn), mapPane(node.children[1], id, fn)]
  }
}

export const useStore = create<AppState>((set, get) => ({
  groups: [],
  sessions: [],
  tabs: [],
  activeTabId: null,
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

  upsertGroup: async (group) => {
    const saved = await window.td.store.saveGroup(group)
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

  openTab: (title, target) => {
    const leaf = makeLeaf(title, target)
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
    get().splitPaneWith(tabId, paneId, dir, 'after', source.title, source.target)
  },

  splitPaneWith: (tabId, paneId, dir, position, title, target) => {
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const source = findPane(t.root, paneId)
        if (!source || source.type !== 'leaf') return t
        const newLeaf = makeLeaf(title, target)
        const children: [PaneNode, PaneNode] =
          position === 'before' ? [newLeaf, source] : [source, newLeaf]
        const splitNode: PaneNode = { type: 'split', id: nanoid(), dir, children, sizes: [50, 50] }
        return { ...t, root: replacePane(t.root, paneId, splitNode), activePaneId: newLeaf.id }
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
    const apply = (node: PaneNode): PaneNode =>
      node.type === 'leaf'
        ? { ...node, broadcastEnabled: enabled }
        : { ...node, children: [apply(node.children[0]), apply(node.children[1])] }
    set((s) => ({ tabs: s.tabs.map((t) => ({ ...t, root: apply(t.root) })) }))
  },

  resizeSplit: (tabId, splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, root: setSizes(t.root, splitId, sizes) } : t))
    }))
  }
}))

function setSizes(node: PaneNode, id: string, sizes: [number, number]): PaneNode {
  if (node.type === 'split') {
    if (node.id === id) return { ...node, sizes }
    return { ...node, children: [setSizes(node.children[0], id, sizes), setSizes(node.children[1], id, sizes)] }
  }
  return node
}

function findPane(node: PaneNode | null, id: string): PaneNode | undefined {
  if (!node) return undefined
  if (node.id === id) return node
  if (node.type === 'split') {
    return findPane(node.children[0], id) ?? findPane(node.children[1], id)
  }
  return undefined
}

/** Drops a leaf from the tree; the surviving sibling takes the split's place. */
function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === paneId ? null : node
  const a = removePane(node.children[0], paneId)
  const b = removePane(node.children[1], paneId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, children: [a, b] }
}

function replacePane(node: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (node.id === id) return replacement
  if (node.type === 'split') {
    return {
      ...node,
      children: [replacePane(node.children[0], id, replacement), replacePane(node.children[1], id, replacement)]
    }
  }
  return node
}
