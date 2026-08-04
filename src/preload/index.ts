import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  SessionProfile,
  SessionGroup,
  QuickConnectParams,
  PortForwardRule,
  VaultStatus,
  SessionStoreData,
  SftpEntry,
  SshConfigHost
} from '../shared/types'

const api = {
  vault: {
    status: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultStatus),
    create: (password: string): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultCreate, password),
    unlock: (password: string): Promise<{ ok: boolean; error?: string; status?: VaultStatus }> =>
      ipcRenderer.invoke(IPC.vaultUnlock, password),
    lock: (): Promise<VaultStatus> => ipcRenderer.invoke(IPC.vaultLock)
  },
  store: {
    load: (): Promise<SessionStoreData> => ipcRenderer.invoke(IPC.storeLoad),
    saveSession: (session: SessionProfile, secret?: string): Promise<SessionProfile> =>
      ipcRenderer.invoke(IPC.storeSaveSession, session, secret),
    deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeleteSession, id),
    saveGroup: (group: SessionGroup): Promise<SessionGroup> =>
      ipcRenderer.invoke(IPC.storeSaveGroup, group),
    deleteGroup: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeleteGroup, id)
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
  importer: {
    sshConfigHosts: (): Promise<SshConfigHost[]> => ipcRenderer.invoke(IPC.sshConfigRead)
  },
  dialogs: {
    pickPrivateKey: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.dialogPickPrivateKey),
    pickSavePath: (defaultName: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.dialogPickSavePath, defaultName),
    pickOpenPath: (): Promise<string | undefined> => ipcRenderer.invoke(IPC.dialogPickOpenPath)
  }
}

contextBridge.exposeInMainWorld('td', api)

export type TerminalDeckApi = typeof api
