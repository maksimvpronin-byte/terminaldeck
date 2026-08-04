export type AuthMethod = 'password' | 'privateKey' | 'agent'

export interface SessionGroup {
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

export interface SessionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** Path to private key file, used when authMethod === 'privateKey' */
  privateKeyPath?: string
  /** Reference id into the vault for password / key passphrase. Absent = no secret stored. */
  secretRef?: string
  groupId: string | null
  tags: string[]
  /** id of another SessionProfile to use as a jump host (ProxyJump) */
  jumpHostId?: string | null
  agentForward: boolean
  logToFile: boolean
  portForwards: PortForwardRule[]
  color?: string
  createdAt: number
  updatedAt: number
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
