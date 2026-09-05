export const IPC = {
  aiSettings: 'ai:settings',
  aiSave: 'ai:save',
  aiClear: 'ai:clear',
  aiTest: 'ai:test',
  aiStart: 'ai:start',
  aiGet: 'ai:get',
  aiDecide: 'ai:decide',
  aiReport: 'ai:report',
  aiStop: 'ai:stop',
  aiUpdate: 'ai:update',
  // Vault
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultChangePassword: 'vault:changePassword',

  // Trusted host keys
  knownHostsList: 'knownHosts:list',
  knownHostsRemove: 'knownHosts:remove',
  /** TLS certificates trusted for a desktop session, and dropping one. */
  knownCertificatesList: 'knownCertificates:list',
  knownCertificatesRemove: 'knownCertificates:remove',

  // Session store (groups + saved connections, metadata only)
  storeLoad: 'store:load',
  storeSaveSession: 'store:saveSession',
  storeDeleteSession: 'store:deleteSession',
  storeReorderSessions: 'store:reorderSessions',
  storeSaveGroup: 'store:saveGroup',
  storeReorderGroups: 'store:reorderGroups',
  storeDeleteGroup: 'store:deleteGroup',

  // Inventory sources backed by git
  inventoryList: 'inventory:list',
  inventorySaveSource: 'inventory:saveSource',
  inventoryRemoveSource: 'inventory:removeSource',
  inventorySync: 'inventory:sync',
  inventorySyncAll: 'inventory:syncAll',
  inventorySaveOverride: 'inventory:saveOverride',
  inventoryClearOverride: 'inventory:clearOverride',
  inventoryGitAvailable: 'inventory:gitAvailable',

  /**
   * A Sessions folder mirroring an inventory out of git: reading the repository,
   * then taking what was agreed to in the dialog that read produced.
   */
  gitFolderList: 'gitFolder:list',
  gitFolderPreview: 'gitFolder:preview',
  gitFolderApply: 'gitFolder:apply',
  gitFolderForgetRepo: 'gitFolder:forgetRepo',
  gitFolderSaveOverride: 'gitFolder:saveOverride',
  gitFolderClearOverride: 'gitFolder:clearOverride',

  // Backup
  backupExport: 'backup:export',
  backupImport: 'backup:import',

  // Snippets
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',

  /**
   * Logins saved on their own, offered to any host at the moment of connecting.
   * Metadata only — the password itself stays in the vault.
   */
  credentialsList: 'credentials:list',
  credentialsSave: 'credentials:save',
  credentialsDelete: 'credentials:delete',

  // Collections
  collectionsList: 'collections:list',
  collectionsSave: 'collections:save',
  collectionsDelete: 'collections:delete',
  collectionsReorder: 'collections:reorder',

  // SSH connection lifecycle
  sshConnect: 'ssh:connect',
  sshQuickConnect: 'ssh:quickConnect',
  sshDisconnect: 'ssh:disconnect',
  sshWrite: 'ssh:write',
  /** The renderer reporting output written to the terminal, so reading can resume. */
  sshAck: 'ssh:ack',
  sshResize: 'ssh:resize',
  // events pushed from main -> renderer, suffixed with connectionId at runtime
  sshData: 'ssh:data',
  sshStatus: 'ssh:status',
  sshError: 'ssh:error',
  sshCwd: 'ssh:cwd',
  sshSetFollowCwd: 'ssh:setFollowCwd',
  sshGetFollowCwd: 'ssh:getFollowCwd',

  // SFTP
  sftpList: 'sftp:list',
  sftpRealpath: 'sftp:realpath',
  sftpStat: 'sftp:stat',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpMkdir: 'sftp:mkdir',
  sftpDelete: 'sftp:delete',
  sftpRename: 'sftp:rename',
  sftpDownloadDir: 'sftp:downloadDir',
  sftpUploadPath: 'sftp:uploadPath',
  sftpPlanUpload: 'sftp:planUpload',
  sftpPlanDownload: 'sftp:planDownload',
  /** Host to host, through us: neither server can reach the other directly. */
  sftpPlanRelay: 'sftp:planRelay',
  sftpRunPlan: 'sftp:runPlan',
  sftpCompare: 'sftp:compare',
  sftpEdit: 'sftp:edit',
  sftpStopEdit: 'sftp:stopEdit',
  /** main -> renderer, suffixed with connectionId */
  sftpEdited: 'sftp:edited',
  /** main -> renderer, suffixed with connectionId */
  sftpProgress: 'sftp:progress',

  /**
   * Who one host signs in as, and whether a password is saved for it — the
   * answer being a boolean, not the password.
   *
   * It used to return the password itself, from the days when the client
   * authenticated in the window. The client moved into the main process and
   * authenticates there; the window kept calling this and kept using one bit of
   * the answer, so the secret crossed the boundary for nobody. What is left is
   * what the pane actually asks: whose name to show, and whether to ask for a
   * password before starting.
   */
  rdpLogin: 'rdp:login',
  /**
   * The desktop settings for one host — size, keyboard — resolved through the
   * inheritance chain. The gateway is deliberately not among them: the window
   * never learns where a session is routed, let alone the password it takes.
   */
  rdpSettings: 'rdp:settings',
  /**
   * A desktop session, drawn by td-rdp in a process of its own.
   *
   * The window asks for one by naming a saved host, and gets back an id. It is
   * never told where that host is reached or who it is reached as — with the
   * client out of the renderer, authentication happens in the main process and
   * a stored password has no reason to cross into the window at all.
   */
  desktopStart: 'desktop:start',
  /**
   * Everything the window has to say to a running session: keys, the mouse, a
   * new size, and the acknowledgement of a frame.
   *
   * One channel rather than one per kind, and `send` rather than `invoke`: a
   * mouse moving is sixty messages a second and none of them has an answer
   * worth waiting for.
   */
  desktopSend: 'desktop:send',
  desktopStop: 'desktop:stop',
  /** What the client wrote about itself, for saving where it can be read. */
  desktopLog: 'desktop:log',
  /** main -> renderer, each suffixed with the desktop session id */
  desktopEvent: 'desktop:event',
  desktopFrame: 'desktop:frame',
  desktopCursor: 'desktop:cursor',
  /** Who is logged on to a Windows host, for the shadow picker. */
  rdpListSessions: 'rdp:listSessions',
  /** Opens the Windows client on an existing session, in a window of its own. */
  rdpShadow: 'rdp:shadow',
  /** Shows a shadow session inside a pane, through ShadowHost.exe. */
  shadowStart: 'shadow:start',
  shadowPlace: 'shadow:place',
  shadowVisible: 'shadow:visible',
  shadowStop: 'shadow:stop',
  /** main -> renderer, suffixed with the shadow session id */
  shadowEvent: 'shadow:event',

  // Remote monitoring
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  /** main -> renderer, suffixed with connectionId; null means it gave up */
  monitorStats: 'monitor:stats',

  // Port forwarding
  pfStart: 'pf:start',
  pfStop: 'pf:stop',
  pfStatus: 'pf:status',

  // Import
  sshConfigRead: 'import:sshConfig',

  // Auto-update
  updateGetState: 'update:getState',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  /** main -> renderer */
  updateState: 'update:state',

  // Interactive auth (password prompt, keyboard-interactive / 2FA)
  /** main -> renderer */
  authPrompt: 'auth:prompt',
  /** renderer -> main, suffixed with the request id */
  authPromptReply: 'auth:promptReply',

  /** main -> renderer: terminal font zoom, intercepted before Chromium's page zoom */
  uiZoom: 'ui:zoom',
  /**
   * renderer -> main: whether a full-screen desktop owns the keyboard.
   *
   * The main process has to claim the zoom keys before Chromium can act on
   * them, which puts it in front of a session that should be receiving every
   * key. This is how it learns to hand them over instead.
   */
  uiKeyboardCapture: 'ui:keyboardCapture',
  /** main -> renderer: a key main had to claim, for the session to send on. */
  uiForwardKey: 'ui:forwardKey',

  /**
   * The two things a sandboxed preload cannot do for itself.
   *
   * Both are answered synchronously — `sendSync` — because both are read where
   * an answer is needed at once: the account name as the bridge is built, and
   * the clipboard in the middle of a paste. One blocking round trip on a
   * keystroke is cheaper than reshaping every caller around a promise.
   */
  appLocalUsername: 'app:localUsername',
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',

  // Session logs
  logsReveal: 'logs:reveal',

  // Dialogs
  dialogPickPrivateKey: 'dialog:pickPrivateKey',
  dialogPickSavePath: 'dialog:pickSavePath',
  dialogPickOpenPath: 'dialog:pickOpenPath',
  dialogPickDirectory: 'dialog:pickDirectory'
} as const
