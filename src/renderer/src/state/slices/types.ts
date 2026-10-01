import type { TerminalSettings } from '../settings'
import type { PaneNode, PaneTarget } from '../paneTree'
import type {
  Credential,
  GitFolderApplyOptions,
  GitFolderPreview,
  GitFolderTree,
  GitRepo,
  HostCollection,
  MultiWindow,
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
  /** Several new hosts in one write, without passwords: all are kept, or none. */
  upsertSessions: (sessions: SessionProfile[]) => Promise<void>
  removeSession: (id: string) => Promise<void>
  /** Several hosts in one write, for a selection. */
  removeSessions: (ids: string[]) => Promise<void>
  upsertGroup: (
    group: SessionGroup,
    secret?: string | null,
    gatewaySecret?: string | null,
    /** The password RDP hosts in the group sign in with; see RdpLoginDefaults. */
    rdpSecret?: string | null
  ) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  moveSession: (sessionId: string, groupId: string | null) => Promise<void>
  /**
   * Drops a session immediately before or after another one, joining that
   * session's group on the way. This is how the tree is sorted by hand.
   */
  reorderSession: (sessionId: string, targetId: string, place: 'before' | 'after') => Promise<void>
  moveGroup: (groupId: string, parentId: string | null) => Promise<void>
  /**
   * Drops a folder immediately before or after another one, joining that
   * folder's parent on the way. This is how the tree is sorted by hand, and it
   * is the same gesture hosts have always had.
   */
  reorderGroup: (groupId: string, targetId: string, place: 'before' | 'after') => Promise<void>
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

/**
 * Folders on the Sessions tab that mirror an Ansible inventory out of git.
 *
 * Separate from the inventory slice because the two answer different questions:
 * an Inventory source is a place of its own in the sidebar, while these hang
 * inside the ordinary tree, under a folder somebody made.
 */
export interface GitFoldersSlice {
  gitFolderTrees: GitFolderTree[]
  gitFolderOverrides: InventoryOverride[]
  /**
   * Repositories already in use, so a second folder on the same inventory is
   * chosen from a list rather than typed out again.
   */
  gitRepos: GitRepo[]
  /** Folders whose repository is being read right now. */
  gitFolderSyncing: string[]
  /** Why the last attempt to read a folder's repository failed, if it did. */
  gitFolderErrors: Record<string, string>
  loadGitFolders: () => Promise<void>
  /**
   * Pulls the repository and returns what taking it would mean. Nothing the
   * folder shows changes until `applyGitFolder` is called with an answer;
   * undefined means the repository could not be read.
   */
  previewGitFolder: (groupId: string) => Promise<GitFolderPreview | undefined>
  applyGitFolder: (
    groupId: string,
    includedGroups: string[],
    options?: GitFolderApplyOptions
  ) => Promise<void>
  saveGitFolderOverride: (
    override: InventoryOverride,
    secret?: string | null,
    gatewaySecret?: string | null
  ) => Promise<void>
  clearGitFolderOverride: (nodeId: string) => Promise<void>
  forgetGitRepo: (url: string, branch?: string) => Promise<void>
}

/** A host's menu asked for from elsewhere; see `hostMenuRequest`. */
export interface HostMenuRequest {
  hostId: string
  x: number
  y: number
  /** The tab it was asked for from, whose own items join the host's. */
  tabId?: string
}

export interface MultiWindowsSlice {
  /**
   * A tab waiting to be named as a multi-window, from its right-click menu.
   * The dialog for it lives with the tab bar, which is always there.
   */
  multiWindowDraft: { tabId: string; name: string } | null
  draftMultiWindow: (draft: { tabId: string; name: string } | null) => void
  /** Tabs kept by name, panes and all; see MultiWindow. */
  multiWindows: MultiWindow[]
  loadMultiWindows: () => Promise<void>
  /**
   * Keeps a tab's panes as a multi-window — a new one, or in place of
   * `replaceId`. False when the tab has no saved host in it to keep.
   */
  saveTabAsMultiWindow: (tabId: string, name: string, replaceId?: string) => Promise<boolean>
  renameMultiWindow: (id: string, name: string) => Promise<void>
  removeMultiWindow: (id: string) => Promise<void>
  moveMultiWindow: (id: string, delta: -1 | 1) => Promise<void>
  /** Opens it as a new tab in the workspace in front, every pane connecting. */
  openMultiWindow: (id: string) => void
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

export interface CredentialsSlice {
  /** Logins saved on their own, offered to any host when connecting. */
  credentials: Credential[]
  loadCredentials: () => Promise<void>
  /** `secret`: a string stores it, undefined keeps what is there, null forgets it. */
  upsertCredential: (credential: Credential, secret?: string | null) => Promise<void>
  removeCredential: (id: string) => Promise<void>
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
  /** Drag a tab into the gap beside another tab of the same workspace. */
  reorderTab: (tabId: string, targetId: string, place: 'before' | 'after') => void

  /** Opens a tab in the current workspace, creating one if there is none. */
  openTab: (title: string, target: PaneTarget, color?: string, viaCollectionId?: string) => string
  /**
   * Opens a host the way a double-click does, which is not always a new tab.
   *
   * A desktop is never opened twice for one account: Windows keeps one
   * session per user, so a second tab took the session from the first and
   * left it showing an error. Its existing pane is brought forward instead,
   * and reconnected if it had dropped. A terminal goes the same way while
   * `reuseOpenHost` is on, unless an account was chosen for it. `again` asks
   * for a new tab whatever the setting — a desktop still never gets one.
   * Returns the pane the host is in.
   */
  openHost: (
    title: string,
    target: PaneTarget,
    color?: string,
    viaCollectionId?: string,
    again?: boolean
  ) => string
  /**
   * Bumped for one pane: connect it if it is not connected. See `openHost`;
   * a pane that is connecting or connected ignores it.
   */
  wakeRequest: { paneId: string; n: number } | null
  /**
   * A host's own menu, asked for from somewhere that has none — a tab. The
   * tree that holds the host shows it and clears this. See `Workspace`.
   */
  hostMenuRequest: HostMenuRequest | null
  requestHostMenu: (request: HostMenuRequest | null) => void
  /** Opens a tab of ready-made panes in the workspace in front; returns its id. */
  openPanes: (title: string, root: PaneNode) => string
  /** Opens several hosts at once — see OpenMode. */
  openMany: (items: OpenRequest[], mode: OpenMode, workspaceTitle?: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  /** Flags a background tab that produced output, so the tab bar can show it. */
  markActivity: (tabId: string) => void

  setActivePane: (tabId: string, paneId: string) => void
  /**
   * Bumped to ask the active pane to take the keyboard — see `focusActivePane`.
   * A count rather than a flag, so asking twice for the same pane is heard twice.
   */
  focusRequest: number
  /**
   * The active pane takes the keyboard: the terminal, or the desktop.
   *
   * Only for a pane chosen with the mouse — a host clicked in a tree, a tab
   * clicked in the bar. A tab reached with ⌘1…9 is left alone, because a
   * focused desktop takes every key there is, those included, and the next ⌘2
   * would go to Windows instead of moving on.
   */
  focusActivePane: () => void
  /**
   * Brings forward a pane where this saved host is open, switching workspace
   * and tab as needed, and gives it the keyboard. False when it is open
   * nowhere, and nothing changes.
   */
  revealSession: (sessionId: string) => boolean
  /** A live shell, or undefined once it has closed. See `connectionId` on a leaf. */
  setPaneConnection: (tabId: string, paneId: string, connectionId: string | undefined) => void
  /** A live desktop, or undefined once it has ended. See `desktopId` on a leaf. */
  setPaneDesktop: (tabId: string, paneId: string, desktopId: string | undefined) => void
  splitPane: (tabId: string, paneId: string, dir: 'row' | 'col') => void
  splitPaneWith: (
    tabId: string,
    paneId: string,
    dir: 'row' | 'col',
    position: 'before' | 'after',
    title: string,
    target: PaneTarget,
    color?: string,
    /** The collection the new pane takes its look from, as `openTab` has it. */
    viaCollectionId?: string
  ) => void
  /**
   * Moves every pane of one tab into another, beside `paneId`, and closes the
   * tab it came from. The panes reconnect, as any pane moved between tabs does.
   */
  mergeTabInto: (
    sourceTabId: string,
    targetTabId: string,
    paneId: string,
    dir: 'row' | 'col',
    position: 'before' | 'after'
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
  GitFoldersSlice &
  SnippetsSlice &
  CollectionsSlice &
  MultiWindowsSlice &
  CredentialsSlice &
  WorkspaceSlice
