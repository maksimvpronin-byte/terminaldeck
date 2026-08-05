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
}

export interface SessionGroup extends AuthDefaults {
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

export interface SessionProfile extends AuthDefaults {
  id: string
  name: string
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
}

/** A git repository that machine inventories are read out of. */
export interface InventorySource extends AuthDefaults {
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
}

/** Local changes layered over a host that came from a repository. */
export interface InventoryOverride extends AuthDefaults {
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

export interface SftpEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtime: number
  permissions: string
}
