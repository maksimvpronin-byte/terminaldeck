export const IPC = {
  // Vault
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultLock: 'vault:lock',

  // Session store (groups + saved connections, metadata only)
  storeLoad: 'store:load',
  storeSaveSession: 'store:saveSession',
  storeDeleteSession: 'store:deleteSession',
  storeSaveGroup: 'store:saveGroup',
  storeDeleteGroup: 'store:deleteGroup',

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

  // SFTP
  sftpList: 'sftp:list',
  sftpDownload: 'sftp:download',
  sftpUpload: 'sftp:upload',
  sftpMkdir: 'sftp:mkdir',
  sftpDelete: 'sftp:delete',
  sftpRename: 'sftp:rename',
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

  // Dialogs
  dialogPickPrivateKey: 'dialog:pickPrivateKey',
  dialogPickSavePath: 'dialog:pickSavePath',
  dialogPickOpenPath: 'dialog:pickOpenPath'
} as const
