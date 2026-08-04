import { create } from 'zustand'
import { nanoid } from 'nanoid'
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
    }
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: [PaneNode, PaneNode]; sizes: [number, number] }

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

  lockVault: () => Promise<void>
  setVaultUnlocked: () => void
  loadStore: () => Promise<void>
  upsertSession: (session: SessionProfile, secret?: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  upsertGroup: (group: SessionGroup) => Promise<void>
  removeGroup: (id: string) => Promise<void>

  openTab: (title: string, target: PaneTarget) => string
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  setActivePane: (tabId: string, paneId: string) => void
  setPaneConnection: (tabId: string, paneId: string, connectionId: string) => void
  splitPane: (tabId: string, paneId: string, dir: 'row' | 'col') => void
  toggleSftp: (tabId: string, paneId: string) => void
  toggleTunnels: (tabId: string, paneId: string) => void
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
    tunnelsOpen: false
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

export const useStore = create<AppState>((set) => ({
  groups: [],
  sessions: [],
  tabs: [],
  activeTabId: null,
  vaultLocked: false,

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
    set((s) => ({
      groups: s.groups.filter((x) => x.id !== id),
      sessions: s.sessions.map((x) => (x.groupId === id ? { ...x, groupId: null } : x))
    }))
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
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t
        const source = findPane(t.root, paneId)
        if (!source || source.type !== 'leaf') return t
        const newLeaf = makeLeaf(source.title, source.target)
        const splitNode: PaneNode = {
          type: 'split',
          id: nanoid(),
          dir,
          children: [source, newLeaf],
          sizes: [50, 50]
        }
        return { ...t, root: replacePane(t.root, paneId, splitNode), activePaneId: newLeaf.id }
      })
    }))
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

function findPane(node: PaneNode, id: string): PaneNode | undefined {
  if (node.id === id) return node
  if (node.type === 'split') {
    return findPane(node.children[0], id) ?? findPane(node.children[1], id)
  }
  return undefined
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
