import type { TerminalSettings } from '../settings'
import type { PaneNode, PaneTarget } from '../paneTree'
import type {
  HostCollection,
  InventoryOverride,
  InventorySource,
  InventoryTree,
  SessionGroup,
  SessionProfile,
  Snippet
} from '../../../../shared/types'

/**
 * One host-level tab: a tree of panes, so a tab can still be split.
 * Ids are unique across every workspace, which lets the pane actions keep
 * taking a bare tabId instead of threading a workspace id through the UI.
 */
export interface WorkspaceTab {
  id: string
  title: string
  root: PaneNode
  activePaneId: string
  /** Output arrived while the tab was in the background. */
  hasActivity?: boolean
}

/**
 * The top strip: a named container holding its own row of tabs, the way a
 * Chrome window holds tabs. Opening a whole host group gives you one of these
 * with a tab per host.
 */
export interface Workspace {
  id: string
  title: string
  color?: string
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export interface OpenRequest {
  title: string
  target: PaneTarget
  color?: string
  /** Set when opening from a collection, so its look travels with the pane. */
  viaCollectionId?: string
}

/**
 * Where a batch of hosts should land: one tab each in the current workspace,
 * all tiled into a single tab, or a new workspace of their own.
 */
export type OpenMode = 'tabs' | 'grid' | 'workspace'

export interface VaultSlice {
  vaultLocked: boolean
  lockVault: () => Promise<void>
  setVaultUnlocked: () => void
}

export interface SettingsSlice {
  settings: TerminalSettings
  updateSettings: (patch: Partial<TerminalSettings>) => void
}

export interface SessionsSlice {
  groups: SessionGroup[]
  sessions: SessionProfile[]
  loadStore: () => Promise<void>
  /** `secret`: a string stores it, undefined keeps what is there, null forgets it. */
  upsertSession: (
    session: SessionProfile,
    secret?: string | null,
    gatewaySecret?: string | null
  ) => Promise<void>
  removeSession: (id: string) => Promise<void>
  upsertGroup: (
    group: SessionGroup,
    secret?: string | null,
    gatewaySecret?: string | null
  ) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  moveSession: (sessionId: string, groupId: string | null) => Promise<void>
  /**
   * Drops a session immediately before or after another one, joining that
   * session's group on the way. This is how the tree is sorted by hand.
   */
  reorderSession: (
    sessionId: string,
    targetId: string,
    place: 'before' | 'after'
  ) => Promise<void>
  moveGroup: (groupId: string, parentId: string | null) => Promise<void>
}

export interface InventorySlice {
  inventorySources: InventorySource[]
  inventoryOverrides: InventoryOverride[]
  inventoryTrees: InventoryTree[]
  inventorySyncing: string[]
  /**
   * Errors the sync raised before it could be recorded on the source itself —
   * without these the renderer swallowed them and the button did nothing at all.
   */
  inventorySyncErrors: Record<string, string>
  gitAvailable: boolean
  loadInventory: () => Promise<void>
  syncInventory: (sourceId?: string) => Promise<void>
  saveInventorySource: (source: InventorySource) => Promise<void>
  removeInventorySource: (id: string) => Promise<void>
  saveInventoryOverride: (
    override: InventoryOverride,
    secret?: string | null,
    gatewaySecret?: string | null
  ) => Promise<void>
  clearInventoryOverride: (nodeId: string) => Promise<void>
}

export interface CollectionsSlice {
  collections: HostCollection[]
  loadCollections: () => Promise<void>
  upsertCollection: (collection: HostCollection) => Promise<void>
  removeCollection: (id: string) => Promise<void>
  /** Shifts a collection up or down, so the list reads in the order you want. */
  moveCollection: (id: string, delta: -1 | 1) => Promise<void>
  /** Appends hosts, keeping the existing order and ignoring ones already in. */
  addToCollection: (id: string, hostIds: string[]) => Promise<void>
  removeFromCollection: (id: string, hostId: string) => Promise<void>
  /** Reopens a collection: a workspace of its own, one tab per host. */
  openCollection: (id: string) => void
}

export interface SnippetsSlice {
  snippets: Snippet[]
  loadSnippets: () => Promise<void>
  upsertSnippet: (snippet: Snippet) => Promise<void>
  removeSnippet: (id: string) => Promise<void>
}

export interface WorkspaceSlice {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  /** When on, typing in any terminal is mirrored to every open pane, everywhere. */
  broadcast: boolean

  /** Hosts ticked in the tree, across both the saved and inventory tabs. */
  selectedHostIds: string[]
  lastSelectedHostId: string | null
  toggleHostSelection: (id: string) => void
  /** Plain click: this host alone, and the anchor for the next Shift-click. */
  selectOnlyHost: (id: string) => void
  /** Shift-click: everything between the previous click and this one. */
  selectHostRange: (orderedIds: string[], toId: string) => void
  clearHostSelection: () => void
  openSelectedHosts: (mode: OpenMode) => void

  /** Creates an empty workspace and makes it current; returns its id. */
  openWorkspace: (title?: string, color?: string) => string
  closeWorkspace: (workspaceId: string) => void
  setActiveWorkspace: (workspaceId: string) => void
  renameWorkspace: (workspaceId: string, title: string) => void
  /** Drag a tab onto another workspace's header to move it there. */
  moveTabToWorkspace: (tabId: string, workspaceId: string) => void

  /** Opens a tab in the current workspace, creating one if there is none. */
  openTab: (
    title: string,
    target: PaneTarget,
    color?: string,
    viaCollectionId?: string
  ) => string
  /** Opens several hosts at once — see OpenMode. */
  openMany: (items: OpenRequest[], mode: OpenMode, workspaceTitle?: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  /** Flags a background tab that produced output, so the tab bar can show it. */
  markActivity: (tabId: string) => void

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
  toggleMonitor: (tabId: string, paneId: string) => void
  toggleBroadcast: () => void
  togglePaneBroadcast: (tabId: string, paneId: string) => void
  setAllPanesBroadcast: (enabled: boolean) => void
  resizeSplit: (tabId: string, splitId: string, sizes: [number, number]) => void

  /** Sends text to the focused terminal, or to all broadcast targets when broadcast is on. */
  sendToTerminals: (text: string, execute: boolean) => number
}

export type AppState = VaultSlice &
  SettingsSlice &
  SessionsSlice &
  InventorySlice &
  SnippetsSlice &
  CollectionsSlice &
  WorkspaceSlice
