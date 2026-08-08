export const IPC = {
  // Vault
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',
  vaultChangePassword: 'vault:changePassword',

  // Trusted host keys
  knownHostsList: 'knownHosts:list',
  knownHostsRemove: 'knownHosts:remove',

  // Session store (groups + saved connections, metadata only)
  storeLoad: 'store:load',
  storeSaveSession: 'store:saveSession',
  storeDeleteSession: 'store:deleteSession',
  storeReorderSessions: 'store:reorderSessions',
  storeSaveGroup: 'store:saveGroup',
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

  // Backup
  backupExport: 'backup:export',
  backupImport: 'backup:import',

  // Snippets
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',

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
  sftpRunPlan: 'sftp:runPlan',
  sftpCompare: 'sftp:compare',
  sftpEdit: 'sftp:edit',
  sftpStopEdit: 'sftp:stopEdit',
  /** main -> renderer, suffixed with connectionId */
  sftpEdited: 'sftp:edited',
  /** main -> renderer, suffixed with connectionId */
  sftpProgress: 'sftp:progress',

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

  // Session logs
  logsReveal: 'logs:reveal',

  // Dialogs
  dialogPickPrivateKey: 'dialog:pickPrivateKey',
  dialogPickSavePath: 'dialog:pickSavePath',
  dialogPickOpenPath: 'dialog:pickOpenPath',
  dialogPickDirectory: 'dialog:pickDirectory'
} as const
