import { contextBridge, ipcRenderer, webUtils, clipboard } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  SessionProfile,
  SessionGroup,
  QuickConnectParams,
  PortForwardRule,
  VaultStatus,
  SessionStoreData,
  SftpEntry,
  SshConfigHost,
  UpdateState,
  Snippet,
  AuthPromptRequest,
  InventorySource,
  InventoryOverride,
  InventoryTree
} from '../shared/types'

const api = {
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultStatus),
    create: (password: string): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultCreate, password),
    unlock: (password: string): Promise<{ ok: boolean; error?: string; status?: VaultStatus }> =>
      ipcRenderer.invoke(IPC.vaultUnlock, password),
    lock: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultLock),
    changePassword: (
      current: string,
      next: string
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.vaultChangePassword, current, next)
  },
  knownHosts: {
    list: (): Promise<Array<{ host: string; fingerprint: string }>> =>
      ipcRenderer.invoke(IPC.knownHostsList),
    remove: (host: string): Promise<void> => ipcRenderer.invoke(IPC.knownHostsRemove, host)
  },
  store: {
    load: (): Promise<SessionStoreData> => ipcRenderer.invoke(IPC.storeLoad),
    saveSession: (session: SessionProfile, secret?: string): Promise<SessionProfile> =>
      ipcRenderer.invoke(IPC.storeSaveSession, session, secret),
    deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeleteSession, id),
    saveGroup: (group: SessionGroup, secret?: string): Promise<SessionGroup> =>
      ipcRenderer.invoke(IPC.storeSaveGroup, group, secret),
    deleteGroup: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeleteGroup, id)
  },
  inventory: {
    gitAvailable: (): Promise<boolean> => ipcRenderer.invoke(IPC.inventoryGitAvailable),
    list: (): Promise<{
      sources: InventorySource[]
      overrides: InventoryOverride[]
      trees: InventoryTree[]
    }> => ipcRenderer.invoke(IPC.inventoryList),
    saveSource: (source: InventorySource): Promise<InventorySource> =>
      ipcRenderer.invoke(IPC.inventorySaveSource, source),
    removeSource: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC.inventoryRemoveSource, id),
    sync: (id: string): Promise<InventoryTree> => ipcRenderer.invoke(IPC.inventorySync, id),
    syncAll: (): Promise<void> => ipcRenderer.invoke(IPC.inventorySyncAll),
    saveOverride: (override: InventoryOverride, secret?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.inventorySaveOverride, override, secret),
    clearOverride: (nodeId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.inventoryClearOverride, nodeId)
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsList),
    save: (snippet: Snippet): Promise<Snippet> => ipcRenderer.invoke(IPC.snippetsSave, snippet),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.snippetsDelete, id)
  },
  ssh: {
    connect: (sessionId: string, cols: number, rows: number): Promise<{ connectionId: string }> =>
      ipcRenderer.invoke(IPC.sshConnect, sessionId, cols, rows),
    quickConnect: (
      params: QuickConnectParams,
      cols: number,
      rows: number
    ): Promise<{ connectionId: string }> =>
      ipcRenderer.invoke(IPC.sshQuickConnect, params, cols, rows),
    disconnect: (connectionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sshDisconnect, connectionId),
    write: (connectionId: string, data: string): void =>
      ipcRenderer.send(IPC.sshWrite, connectionId, data),
    resize: (connectionId: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.sshResize, connectionId, cols, rows),
    onData: (connectionId: string, cb: (base64: string) => void): (() => void) => {
      const channel = `${IPC.sshData}:${connectionId}`
      const listener = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onStatus: (connectionId: string, cb: (status: string) => void): (() => void) => {
      const channel = `${IPC.sshStatus}:${connectionId}`
      const listener = (_e: unknown, status: string): void => cb(status)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onError: (connectionId: string, cb: (message: string) => void): (() => void) => {
      const channel = `${IPC.sshError}:${connectionId}`
      const listener = (_e: unknown, message: string): void => cb(message)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  sftp: {
    list: (connectionId: string, path: string): Promise<SftpEntry[]> =>
      ipcRenderer.invoke(IPC.sftpList, connectionId, path),
    mkdir: (connectionId: string, path: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpMkdir, connectionId, path),
    delete: (connectionId: string, path: string, isDirectory: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpDelete, connectionId, path, isDirectory),
    rename: (connectionId: string, oldPath: string, newPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpRename, connectionId, oldPath, newPath),
    download: (connectionId: string, remotePath: string, localPath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpDownload, connectionId, remotePath, localPath),
    upload: (connectionId: string, localPath: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpUpload, connectionId, localPath, remotePath),
    downloadDirectory: (
      connectionId: string,
      remotePath: string,
      localDir: string
    ): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpDownloadDir, connectionId, remotePath, localDir),
    uploadPath: (connectionId: string, localPath: string, remoteParent: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpUploadPath, connectionId, localPath, remoteParent),
    onProgress: (
      connectionId: string,
      cb: (p: { path: string; transferred: number; total: number }) => void
    ): (() => void) => {
      const channel = `${IPC.sftpProgress}:${connectionId}`
      const listener = (
        _e: unknown,
        payload: { path: string; transferred: number; total: number }
      ): void => cb(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  portForward: {
    start: (connectionId: string, rule: PortForwardRule): Promise<void> =>
      ipcRenderer.invoke(IPC.pfStart, connectionId, rule),
    stop: (connectionId: string, ruleId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.pfStop, connectionId, ruleId),
    status: (connectionId: string): Promise<string[]> => ipcRenderer.invoke(IPC.pfStatus, connectionId)
  },
  updates: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateGetState),
    download: (): Promise<void> => ipcRenderer.invoke(IPC.updateDownload),
    install: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on(IPC.updateState, listener)
      return () => ipcRenderer.removeListener(IPC.updateState, listener)
    }
  },
  auth: {
    onPrompt: (cb: (req: AuthPromptRequest) => void): (() => void) => {
      const listener = (_e: unknown, req: AuthPromptRequest): void => cb(req)
      ipcRenderer.on(IPC.authPrompt, listener)
      return () => ipcRenderer.removeListener(IPC.authPrompt, listener)
    },
    reply: (requestId: string, answers: string[] | null): void => {
      ipcRenderer.send(`${IPC.authPromptReply}:${requestId}`, answers)
    }
  },
  ui: {
    onZoom: (cb: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
      const listener = (_e: unknown, direction: 'in' | 'out' | 'reset'): void => cb(direction)
      ipcRenderer.on(IPC.uiZoom, listener)
      return () => ipcRenderer.removeListener(IPC.uiZoom, listener)
    }
  },
  clipboard: {
    // Electron's own clipboard rather than navigator.clipboard: the packaged app
    // is served from file://, which is not a secure context, so the web API fails.
    read: (): string => clipboard.readText(),
    write: (text: string): void => clipboard.writeText(text)
  },
  logs: {
    reveal: (): Promise<string> => ipcRenderer.invoke(IPC.logsReveal)
  },
  files: {
    /** Electron 32+ dropped File.path; this is the supported replacement. */
    pathFor: (file: File): string => webUtils.getPathForFile(file)
  },
  importer: {
    sshConfigHosts: (): Promise<SshConfigHost[]> => ipcRenderer.invoke(IPC.sshConfigRead)
  },
  dialogs: {
    pickPrivateKey: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.dialogPickPrivateKey),
    pickSavePath: (defaultName: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.dialogPickSavePath, defaultName),
    pickOpenPath: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.dialogPickOpenPath),
    pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.dialogPickDirectory)
  }
}

contextBridge.exposeInMainWorld('td', api)

export type TerminalDeckApi = typeof api
