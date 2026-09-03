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
  HostCollection,
  Credential,
  AuthPromptRequest,
  InventorySource,
  InventoryOverride,
  InventoryTree,
  GitFolderPreview,
  GitFolderTree,
  ImportSummary,
  TransferPlan,
  TransferDecisions,
  FileComparison,
  RdpView
} from '../shared/types'
import type { RemoteStats } from '../shared/remoteStats'
import type { WinSession } from '../shared/winSessions'

/**
 * The far end's pointer: the image it wants shown, or that it wants none.
 *
 * Two shapes rather than one with optional fields, because "hidden" and "a
 * 32×32 image" have nothing in common and a reader should not have to check a
 * width to find out which arrived.
 */
export type DesktopCursor =
  | { width: number; height: number; hotX: number; hotY: number; pixels: Uint8Array }
  | { kind: 'hidden' | 'default' }

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

  /** Certificates trusted by hand, for a gateway or a host that issues its own. */
  knownCertificates: {
    list: (): Promise<Array<{ host: string; fingerprint: string }>> =>
      ipcRenderer.invoke(IPC.knownCertificatesList),
    remove: (host: string): Promise<void> =>
      ipcRenderer.invoke(IPC.knownCertificatesRemove, host)
  },
  store: {
    load: (): Promise<SessionStoreData> => ipcRenderer.invoke(IPC.storeLoad),
    /** `secret`: a string stores it, undefined keeps what is there, null forgets it. */
    saveSession: (
      session: SessionProfile,
      secret?: string | null,
      /** The gateway's own password, when it does not share the host's login. */
      gatewaySecret?: string | null
    ): Promise<SessionProfile> =>
      ipcRenderer.invoke(IPC.storeSaveSession, session, secret, gatewaySecret),
    deleteSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.storeDeleteSession, id),
    /** The full list of session ids, in the order the tree should show them. */
    reorderSessions: (orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.storeReorderSessions, orderedIds),
    saveGroup: (
      group: SessionGroup,
      secret?: string | null,
      gatewaySecret?: string | null
    ): Promise<SessionGroup> =>
      ipcRenderer.invoke(IPC.storeSaveGroup, group, secret, gatewaySecret),
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
    saveOverride: (
      override: InventoryOverride,
      secret?: string | null,
      gatewaySecret?: string | null
    ): Promise<void> =>
      ipcRenderer.invoke(IPC.inventorySaveOverride, override, secret, gatewaySecret),
    clearOverride: (nodeId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.inventoryClearOverride, nodeId)
  },
  /**
   * A Sessions folder that mirrors an inventory out of git.
   *
   * Reading the repository and taking what it found are two calls on purpose:
   * everything between them is the choice made in the dialog, and nothing the
   * folder shows changes until `apply` is called.
   */
  gitFolder: {
    list: (): Promise<{ trees: GitFolderTree[]; overrides: InventoryOverride[] }> =>
      ipcRenderer.invoke(IPC.gitFolderList),
    preview: (groupId: string): Promise<GitFolderPreview> =>
      ipcRenderer.invoke(IPC.gitFolderPreview, groupId),
    apply: (groupId: string, includedGroups: string[]): Promise<GitFolderTree> =>
      ipcRenderer.invoke(IPC.gitFolderApply, groupId, includedGroups),
    saveOverride: (
      override: InventoryOverride,
      secret?: string | null,
      gatewaySecret?: string | null
    ): Promise<void> =>
      ipcRenderer.invoke(IPC.gitFolderSaveOverride, override, secret, gatewaySecret),
    clearOverride: (nodeId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.gitFolderClearOverride, nodeId)
  },
  backup: {
    exportToFile: (includeSecrets: boolean, password?: string): Promise<string | undefined> =>
      ipcRenderer.invoke(IPC.backupExport, includeSecrets, password),
    importFromFile: (password?: string): Promise<ImportSummary | undefined> =>
      ipcRenderer.invoke(IPC.backupImport, password)
  },
  snippets: {
    list: (): Promise<Snippet[]> => ipcRenderer.invoke(IPC.snippetsList),
    save: (snippet: Snippet): Promise<Snippet> => ipcRenderer.invoke(IPC.snippetsSave, snippet),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.snippetsDelete, id)
  },
  /**
   * Logins saved on their own, offered to any host at the moment of connecting.
   * Metadata only in both directions — the password goes in and stays in.
   */
  credentials: {
    list: (): Promise<Credential[]> => ipcRenderer.invoke(IPC.credentialsList),
    /** `secret`: a string stores it, undefined keeps what is there, null forgets it. */
    save: (credential: Credential, secret?: string | null): Promise<Credential> =>
      ipcRenderer.invoke(IPC.credentialsSave, credential, secret),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.credentialsDelete, id)
  },
  collections: {
    list: (): Promise<HostCollection[]> => ipcRenderer.invoke(IPC.collectionsList),
    save: (collection: HostCollection): Promise<HostCollection> =>
      ipcRenderer.invoke(IPC.collectionsSave, collection),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.collectionsDelete, id),
    reorder: (ids: string[]): Promise<void> => ipcRenderer.invoke(IPC.collectionsReorder, ids)
  },
  ssh: {
    /**
     * Opens a shell on a saved host. `credentialId` names a stored login to use
     * in place of the host's own, for this session and no other — nothing is
     * written back to the host.
     */
    connect: (
      sessionId: string,
      cols: number,
      rows: number,
      credentialId?: string
    ): Promise<{ connectionId: string }> =>
      ipcRenderer.invoke(IPC.sshConnect, sessionId, cols, rows, credentialId),
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
    /**
     * Says that `bytes` of output have reached the terminal. Sent for every
     * chunk: it is what releases a connection the main process paused because
     * the renderer had fallen behind.
     */
    ack: (connectionId: string, bytes: number): void =>
      ipcRenderer.send(IPC.sshAck, connectionId, bytes),
    resize: (connectionId: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.sshResize, connectionId, cols, rows),
    /** Raw bytes, exactly as the host sent them. */
    onData: (connectionId: string, cb: (data: Uint8Array) => void): (() => void) => {
      const channel = `${IPC.sshData}:${connectionId}`
      const listener = (_e: unknown, data: Uint8Array): void => cb(data)
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
    },
    setFollowCwd: (connectionId: string, enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IPC.sshSetFollowCwd, connectionId, enabled),
    getFollowCwd: (connectionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.sshGetFollowCwd, connectionId),
    /** Fires only while this connection is tracking the shell's directory. */
    onCwd: (connectionId: string, cb: (path: string) => void): (() => void) => {
      const channel = `${IPC.sshCwd}:${connectionId}`
      const listener = (_e: unknown, path: string): void => cb(path)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  rdp: {
    /** How this host's desktop should be drawn: size, and keyboard behaviour. */
    settings: (sessionId: string): Promise<RdpView> =>
      ipcRenderer.invoke(IPC.rdpSettings, sessionId),
    /**
     * The stored login for one host, or for the account chosen in its place;
     * the password is empty when none is saved.
     */
    credentials: (
      sessionId: string,
      credentialId?: string
    ): Promise<{ username: string; password: string }> =>
      ipcRenderer.invoke(IPC.rdpCredentials, sessionId, credentialId),
    /**
     * Who is logged on to a host, by host id: the query needs that host's own
     * login, which main resolves without handing it here. Never rejects; says
     * why it found nobody.
     */
    listSessions: (
      sessionId: string,
      credentialId?: string
    ): Promise<{ sessions: WinSession[]; problem?: string }> =>
      ipcRenderer.invoke(IPC.rdpListSessions, sessionId, credentialId),
    /**
     * Shows a shadow session inside a pane. The picture belongs to a window
     * this app positions rather than draws, so the pane has to keep reporting
     * where it is.
     */
    shadowStart: (request: {
      host: string
      sessionId: number
      control: boolean
      noPrompt: boolean
      /** The saved connection, so the main process can find the host's
       *  credentials. The password never comes back through here. */
      profileId?: string
      /** A stored account to authenticate the viewer as instead. */
      credentialId?: string
    }): Promise<string> => ipcRenderer.invoke(IPC.shadowStart, request),
    shadowPlace: (
      id: string,
      rect: { x: number; y: number; width: number; height: number }
    ): void => ipcRenderer.send(IPC.shadowPlace, id, rect),
    shadowVisible: (id: string, visible: boolean): void =>
      ipcRenderer.send(IPC.shadowVisible, id, visible),
    shadowStop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.shadowStop, id),
    onShadowEvent: (
      id: string,
      cb: (p: { event: string; detail?: string }) => void
    ): (() => void) => {
      const channel = `${IPC.shadowEvent}:${id}`
      const listener = (_e: unknown, p: { event: string; detail?: string }): void => cb(p)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    /**
     * Opens a desktop, drawn by a client in a process of its own.
     *
     * A host is named and an id comes back. Where that host is reached and as
     * whom is settled in the main process and never told to the window — the
     * client that used to sign in here is gone, and with it the one reason a
     * stored password ever crossed into the renderer.
     */
    desktopStart: (request: {
      sessionId: string
      width: number
      height: number
      /** 100–500, when the host asked for its density to be sent. */
      scale?: number
      /** Typed here, for a host that has nothing saved. */
      password?: string
      /** A stored account to sign in as instead of the host's own. */
      credentialId?: string
    }): Promise<string> => ipcRenderer.invoke(IPC.desktopStart, request),
    /**
     * Anything the pane has to say to a running desktop: a key, the mouse, a
     * new size, or that a frame has been drawn.
     *
     * Fire and forget on purpose. A mouse moving is sixty of these a second and
     * a promise for each would cost more than the message.
     */
    desktopSend: (
      id: string,
      fields: Record<string, string | number | boolean | undefined>
    ): void => ipcRenderer.send(IPC.desktopSend, id, fields),
    desktopStop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.desktopStop, id),
    /** Writes what the client said about itself where it can be read. */
    desktopLog: (id: string): Promise<string> => ipcRenderer.invoke(IPC.desktopLog, id),
    onDesktopEvent: (
      id: string,
      cb: (p: Record<string, unknown>) => void
    ): (() => void) => {
      const channel = `${IPC.desktopEvent}:${id}`
      const listener = (_e: unknown, p: Record<string, unknown>): void => cb(p)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    /**
     * The pixels that changed, as they left the decoder.
     *
     * `pixels` is RGBA with the rows in reading order, which is exactly what
     * `ImageData` takes — so between the far end's screen and this one there is
     * no colour conversion anywhere, only the copies that move the rectangle
     * along.
     */
    onDesktopFrame: (
      id: string,
      cb: (frame: {
        x: number
        y: number
        width: number
        height: number
        pixels: Uint8Array
      }) => void
    ): (() => void) => {
      const channel = `${IPC.desktopFrame}:${id}`
      const listener = (
        _e: unknown,
        frame: { x: number; y: number; width: number; height: number; pixels: Uint8Array }
      ): void => cb(frame)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    /** The far end's mouse pointer: an image with its hotspot, or a state. */
    onDesktopCursor: (id: string, cb: (cursor: DesktopCursor) => void): (() => void) => {
      const channel = `${IPC.desktopCursor}:${id}`
      const listener = (_e: unknown, cursor: DesktopCursor): void => cb(cursor)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    /** Opens the Windows client on an existing session, in a window of its own. */
    shadow: (
      host: string,
      sessionId: number,
      options: { control: boolean; skipPrompt: boolean }
    ): Promise<void> => ipcRenderer.invoke(IPC.rdpShadow, host, sessionId, options)
  },
  sftp: {
    list: (connectionId: string, path: string): Promise<SftpEntry[]> =>
      ipcRenderer.invoke(IPC.sftpList, connectionId, path),
    realpath: (connectionId: string, path: string): Promise<string> =>
      ipcRenderer.invoke(IPC.sftpRealpath, connectionId, path),
    stat: (connectionId: string, path: string): Promise<SftpEntry | null> =>
      ipcRenderer.invoke(IPC.sftpStat, connectionId, path),
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
    planUpload: (
      connectionId: string,
      localPath: string,
      remoteParent: string
    ): Promise<TransferPlan> =>
      ipcRenderer.invoke(IPC.sftpPlanUpload, connectionId, localPath, remoteParent),
    planDownload: (
      connectionId: string,
      remotePath: string,
      localTarget: string,
      exactFile?: boolean
    ): Promise<TransferPlan> =>
      ipcRenderer.invoke(IPC.sftpPlanDownload, connectionId, remotePath, localTarget, exactFile),
    planRelay: (
      srcConnectionId: string,
      srcPath: string,
      dstConnectionId: string,
      destParent: string
    ): Promise<TransferPlan> =>
      ipcRenderer.invoke(IPC.sftpPlanRelay, srcConnectionId, srcPath, dstConnectionId, destParent),
    runPlan: (
      connectionId: string,
      plan: TransferPlan,
      decisions: TransferDecisions,
      /** The far end of a relay; unused by uploads and downloads. */
      destConnectionId?: string
    ): Promise<{ written: number; skipped: number }> =>
      ipcRenderer.invoke(IPC.sftpRunPlan, connectionId, plan, decisions, destConnectionId),
    compare: (
      connectionId: string,
      remotePath: string,
      localPath: string
    ): Promise<FileComparison> =>
      ipcRenderer.invoke(IPC.sftpCompare, connectionId, remotePath, localPath),
    edit: (connectionId: string, remotePath: string, editorCommand?: string): Promise<string> =>
      ipcRenderer.invoke(IPC.sftpEdit, connectionId, remotePath, editorCommand),
    stopEdit: (connectionId: string, remotePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.sftpStopEdit, connectionId, remotePath),
    onEdited: (
      connectionId: string,
      cb: (p: { remotePath: string; savedAt?: number; error?: string }) => void
    ): (() => void) => {
      const channel = `${IPC.sftpEdited}:${connectionId}`
      const listener = (
        _e: unknown,
        payload: { remotePath: string; savedAt?: number; error?: string }
      ): void => cb(payload)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
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
  monitor: {
    start: (connectionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.monitorStart, connectionId),
    stop: (connectionId: string): Promise<void> => ipcRenderer.invoke(IPC.monitorStop, connectionId),
    /** `null` arrives when the poll gave up, so the strip can say so. */
    onStats: (connectionId: string, cb: (stats: RemoteStats | null) => void): (() => void) => {
      const channel = `${IPC.monitorStats}:${connectionId}`
      const listener = (_e: unknown, stats: RemoteStats | null): void => cb(stats)
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
    },
    /**
     * Says whether a full-screen desktop owns the keyboard.
     *
     * The main process claims a few keys before this window sees them, so it
     * has to be told; it then hands them over rather than acting on them.
     */
    setKeyboardCapture: (held: boolean): void =>
      ipcRenderer.send(IPC.uiKeyboardCapture, held),
    /** A key main had to claim, arriving as its `code`, for the session to send. */
    onForwardKey: (cb: (code: string) => void): (() => void) => {
      const listener = (_e: unknown, code: string): void => cb(code)
      ipcRenderer.on(IPC.uiForwardKey, listener)
      return () => ipcRenderer.removeListener(IPC.uiForwardKey, listener)
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
