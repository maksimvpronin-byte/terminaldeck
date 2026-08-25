import type { Protocol } from './protocols'

export type AuthMethod = 'password' | 'privateKey' | 'agent'

/**
 * Connection settings that a session can leave unset and inherit from the group
 * it lives in, and that a group can in turn inherit from its own parent. An
 * absent field means "inherit"; a present one overrides everything above it.
 */
export interface AuthDefaults {
  /**
   * Whether to fall back to the parent group for anything left unset. Defaults
   * to true; set false to stand alone inside a group that defines credentials.
   */
  inheritAuth?: boolean
  port?: number
  username?: string
  authMethod?: AuthMethod
  /** Path to private key file, used when the effective authMethod is 'privateKey' */
  privateKeyPath?: string
  /** Reference id into the vault for password / key passphrase. */
  secretRef?: string
  agentForward?: boolean
  /** id of a SessionProfile to use as a jump host (ProxyJump) */
  jumpHostId?: string | null
  /**
   * Typed into the shell once it is ready, as if the user had. Several lines run
   * in order. Blank inherits, so "everything here starts with sudo -i" is stated
   * once on the group.
   *
   * Read from local configuration only. An inventory repository must never be
   * able to set this: it is arbitrary code on every connection, and honouring it
   * from a repo would hand command execution to anyone who can commit there.
   */
  onConnectCommand?: string
  /**
   * Keep the SFTP panel on the directory the shell is in, by watching for the
   * OSC 7 sequence the shell prints on each prompt. Off unless asked for: it
   * sends a setup line to the shell on connect, and lets the remote host move
   * the file browser.
   */
  followTerminalCwd?: boolean
}

/** How a desktop's resolution is decided. */
export type RdpResolution = 'fit' | 'fixed'

/**
 * Settings that only mean anything for a desktop, inherited along the same walk
 * as AuthDefaults — the host, then its group, then that group's parent. An
 * absent field means "inherit".
 *
 * Separate from AuthDefaults and opted out of separately, for the same reason
 * appearance is: a gateway describes *where a machine lives*, which a whole
 * group shares, while a login describes who you are on it, which a host may
 * well hold alone.
 */
export interface RdpDefaults {
  /** Whether to fall back to the group for anything left unset. Defaults true. */
  inheritRdp?: boolean
  /**
   * A Remote Desktop Gateway to reach the host through. Blank connects to the
   * host directly, which is what every session did before this field existed.
   */
  gatewayHost?: string
  gatewayPort?: number
  /**
   * The login presented to the gateway, which is regularly not the one used on
   * the host itself. Blank means the host's own credentials are offered.
   */
  gatewayUsername?: string
  /** Reference id into the vault for the gateway password. */
  gatewaySecretRef?: string
  /**
   * Skip the gateway for a host that resolves to a private address, the way
   * `gatewayusagemethod:4` does in an .rdp file. Off by default: silently not
   * using a gateway that was configured is worse than failing to reach a host.
   */
  gatewayBypassLocal?: boolean
  /**
   * `fit` follows the pane and resizes the far end with it, which is what the
   * app has always done. `fixed` pins the desktop to a stated size and scales
   * the picture into the pane, for a host that resizes badly or a session that
   * has to keep one geometry.
   */
  resolution?: RdpResolution
  desktopWidth?: number
  desktopHeight?: number
  /**
   * Ask for a desktop as many pixels as the screen physically has, rather than
   * as many as the pane measures in CSS.
   *
   * On a Retina display the two differ by a factor of two in each direction. At
   * CSS size the far end draws a small desktop that the screen then magnifies:
   * everything looks large and soft. At device size it draws every pixel the
   * screen can show — sharp, and with twice the desktop in the same space, so
   * windows and text look their proper size.
   *
   * The cost is real: four times the pixels to encode, send and paint. On a
   * slow link that is the difference between a session that keeps up and one
   * that does not, which is why this is a choice and not a default.
   */
  hiDpi?: boolean
  /**
   * Send ⌘ as Ctrl, so the copy and paste muscle memory of the Mac lands as the
   * Windows one. Off by default: while it is on, ⌘ combinations belong to the
   * desktop and this app's own shortcuts do not fire over a focused session.
   */
  commandAsControl?: boolean
}

/**
 * The part of a resolved desktop the window is told about: how to draw it, and
 * nothing about how it is routed. See the `rdp:settings` handler.
 */
export type RdpView = Pick<
  ResolvedRdp,
  'resolution' | 'desktopWidth' | 'desktopHeight' | 'hiDpi' | 'commandAsControl'
>

/** An RdpDefaults chain collapsed into concrete values ready to connect with. */
export interface ResolvedRdp {
  gatewayHost?: string
  gatewayPort: number
  gatewayUsername?: string
  gatewaySecretRef?: string
  gatewayBypassLocal: boolean
  resolution: RdpResolution
  desktopWidth: number
  desktopHeight: number
  hiDpi: boolean
  commandAsControl: boolean
}

export type CursorStyle = 'block' | 'underline' | 'bar'

/**
 * Terminal look-and-feel that a session can leave unset and inherit from its
 * group, a group from its parent, and anything that reaches the top from the
 * application-wide settings. An absent field means "inherit".
 *
 * Deliberately separate from AuthDefaults: the two are opted out of
 * independently, so a host can keep the group's login while wearing its own
 * colours — which is the point of marking production red.
 */
export interface AppearanceDefaults {
  /**
   * Whether to fall back to the parent group for anything left unset. Defaults
   * to true; set false to stand alone inside a group that defines appearance.
   */
  inheritAppearance?: boolean
  fontFamily?: string
  fontSize?: number
  /** Key into THEMES; affects this terminal only, never the app's own chrome. */
  themeName?: string
  cursorStyle?: CursorStyle
  cursorBlink?: boolean
  scrollback?: number
}

/** An AppearanceDefaults chain collapsed into concrete values for xterm. */
export interface ResolvedAppearance {
  fontFamily: string
  fontSize: number
  themeName: string
  cursorStyle: CursorStyle
  cursorBlink: boolean
  scrollback: number
}

export interface SessionGroup extends AuthDefaults, AppearanceDefaults, RdpDefaults {
  id: string
  name: string
  parentId: string | null
}

export interface PortForwardRule {
  id: string
  type: 'local' | 'remote' | 'dynamic'
  /** Local bind address/port (source for local/dynamic, listener for remote-side is implicit) */
  srcHost: string
  srcPort: number
  /** Target address/port on the far side. Unused for 'dynamic' (SOCKS). */
  dstHost?: string
  dstPort?: number
}

export interface SessionProfile extends AuthDefaults, AppearanceDefaults, RdpDefaults {
  id: string
  name: string
  /**
   * What this machine speaks. Absent means SSH — every host saved before the
   * field existed is one, and unlike the AuthDefaults fields this one does not
   * inherit: it says what a machine is, and a group holds Linux and Windows
   * boxes alike. See shared/protocols.ts.
   */
  protocol?: Protocol
  host: string
  groupId: string | null
  tags: string[]
  logToFile: boolean
  portForwards: PortForwardRule[]
  color?: string
  createdAt: number
  updatedAt: number
}

/** An AuthDefaults chain collapsed into concrete values ready to connect with. */
export interface ResolvedAuth {
  port: number
  username: string
  authMethod: AuthMethod
  privateKeyPath?: string
  secretRef?: string
  agentForward: boolean
  jumpHostId: string | null
  onConnectCommand?: string
  followTerminalCwd: boolean
}

/** A git repository that machine inventories are read out of. */
export interface InventorySource extends AuthDefaults, AppearanceDefaults, RdpDefaults {
  id: string
  name: string
  repoUrl: string
  branch?: string
  /** Paths inside the repo to read; a directory pulls in its *.yml files. */
  paths: string[]
  color?: string
  lastSyncedAt?: number
  lastRevision?: string
  lastError?: string
  /**
   * Repo-relative paths the last sync actually parsed. Without this a sync that
   * quietly read the wrong files — or none — looks exactly like one that worked.
   */
  lastFiles?: string[]
}

/** Local changes layered over a host that came from a repository. */
export interface InventoryOverride extends AuthDefaults, AppearanceDefaults, RdpDefaults {
  /** Derived id of the host or group it applies to, stable across syncs. */
  nodeId: string
  color?: string
}

export interface InventoryData {
  version: 1
  sources: InventorySource[]
  overrides: InventoryOverride[]
}

/** What a sync produced: the same shapes the manual tree uses. */
export interface InventoryTree {
  sourceId: string
  groups: SessionGroup[]
  sessions: SessionProfile[]
  /**
   * Host id to every group that names it. A host stays one entity with one
   * `groupId` — the group its connection settings come from — but Ansible lets
   * it belong to several, and the tree shows it under each.
   */
  memberships: Record<string, string[]>
}

export interface SessionStoreData {
  version: 1
  groups: SessionGroup[]
  sessions: SessionProfile[]
}

export interface VaultStatus {
  exists: boolean
  unlocked: boolean
}

export interface QuickConnectParams {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface ConnectResult {
  connectionId: string
}

export interface TerminalResizePayload {
  connectionId: string
  cols: number
  rows: number
}

export interface AuthPromptField {
  prompt: string
  /** false for secrets, so the field masks input */
  echo: boolean
}

export interface AuthPromptRequest {
  requestId: string
  /** Which host is asking, so the user knows what they are authenticating to. */
  host: string
  title: string
  instructions?: string
  fields: AuthPromptField[]
}

/** What an import actually brought in, reported back to the user. */
export interface ImportSummary {
  groups: number
  sessions: number
  snippets: number
  collections: number
  inventorySources: number
  inventoryOverrides: number
  secrets: number
}

/**
 * A saved, hand-picked set of hosts. Independent of the session tree: a host
 * lives in exactly one group but in any number of collections, and being in one
 * has no effect on credentials — those still come from the host's own group.
 *
 * Members are referenced by id, so a collection can mix saved sessions with
 * hosts that came from an inventory repository.
 */
export interface HostCollection extends AppearanceDefaults {
  id: string
  name: string
  /**
   * Worn by every host seen through this set, or opened from it. A host's own
   * colour still wins. A host in several sets is not forced to pick one: it
   * simply looks like whichever set you are looking at it through.
   */
  color?: string
  /** Session or inventory host ids, in the order the user arranged them. */
  hostIds: string[]
  createdAt: number
  updatedAt: number
}

export interface Snippet {
  id: string
  name: string
  command: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

export interface SshConfigHost {
  alias: string
  hostname: string
  user?: string
  port: number
  identityFile?: string
  proxyJump?: string
}

/** One file a transfer intends to write, in either direction. */
export interface TransferItem {
  sourcePath: string
  destPath: string
  sourceSize: number
  sourceMtime: number
}

/**
 * Why a destination is occupied. Only `file` can be overwritten — the rest are
 * refused outright, because replacing a directory with a file, or writing
 * through a symlink, is never what someone dragging a folder meant to do.
 */
export type ConflictReason = 'file' | 'directory' | 'symlink' | 'unreadable'

export interface TransferConflict extends TransferItem {
  destSize: number
  destMtime: number
  reason: ConflictReason
}

/**
 * `relay` is host to host: both ends are remote, and the bytes pass through this
 * process because the two servers have no route to each other. Everything else
 * about it — planning, conflicts, decisions — is the same as the other two.
 */
export type TransferDirection = 'upload' | 'download' | 'relay'

export interface TransferPlan {
  direction: TransferDirection
  items: TransferItem[]
  conflicts: TransferConflict[]
  /** Two sources landing on one destination; the batch is refused, not merged. */
  collisions: Array<{ destPath: string; sourcePaths: string[] }>
  totalBytes: number
}

/** Destination path to what to do with it. Anything absent is written. */
export type TransferDecisions = Record<string, 'overwrite' | 'skip'>

/** Both sides of a file comparison, or the reason there is nothing to show. */
export interface FileComparison {
  remotePath: string
  localPath: string
  remote: string | null
  local: string | null
  remoteSize: number
  localSize: number
  /**
   * `binary` — a NUL byte was found, so this is not text.
   * `too-large` — beyond the diff cap; reading it in would hang the window.
   * `missing` — one side is not there any more.
   */
  blocked?: 'binary' | 'too-large' | 'missing'
}

export interface SftpEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtime: number
  permissions: string
  /**
   * Names when the server's listing carried them, otherwise the numeric ids
   * SFTP itself reports. Empty only for entries reached by a bare stat, which
   * has no listing line to read them from.
   */
  owner: string
  group: string
}
