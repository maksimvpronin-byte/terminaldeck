import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { IPC } from '../../shared/ipc-channels'
import { vault, WrongPasswordError } from '../vault/Vault'
import { sessionStore } from '../store/SessionStore'
import { snippetStore } from '../store/SnippetStore'
import { collectionStore } from '../store/CollectionStore'
import { exportToFile, importFromFile } from '../store/Backup'
import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'
import { remoteEdit } from '../ssh/RemoteEdit'
import { portForwardManager } from '../ssh/PortForwardManager'
import { remoteMonitor } from '../ssh/RemoteMonitor'
import { rdpGateway } from '../rdp/Gateway'
import { listSessions, shadowSession } from '../rdp/WinSessions'
import {
  shadowHostBridge,
  type PaneRect,
  type ShadowRequest
} from '../rdp/ShadowHostBridge'
import { resolveAuth } from '../../shared/authResolution'
import { qualifyUser } from '../../shared/winSessions'
import { protocolOf } from '../../shared/protocols'
import { readSshConfigHosts } from '../ssh/sshConfig'
import { knownHosts } from '../ssh/KnownHosts'
import { inventoryStore } from '../inventory/InventoryStore'
import { isGitAvailable } from '../inventory/GitRepo'
import type {
  SessionProfile,
  SessionGroup,
  QuickConnectParams,
  PortForwardRule,
  Snippet,
  HostCollection,
  InventorySource,
  InventoryOverride,
  TransferPlan,
  TransferDecisions
} from '../../shared/types'

function focusedWin(): BrowserWindow {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('No window available')
  return win
}

function reportTransfer(
  connectionId: string,
  path: string,
  transferred: number,
  total: number
): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  win.webContents.send(`${IPC.sftpProgress}:${connectionId}`, { path, transferred, total })
}

/**
 * Drops an item's own credential so it inherits again. Without this a host that
 * once had a password of its own keeps using it forever: the nearest value wins,
 * so moving the host into a group leaves the group's credentials unused.
 *
 * The reference goes even if the vault is locked and the ciphertext cannot be
 * removed right now — an unreferenced secret is unreachable, and leaving the
 * reference behind would keep the old password in use.
 */
function forgetSecret(item: { secretRef?: string }): void {
  if (item.secretRef && vault.status().unlocked) vault.deleteSecret(item.secretRef)
  item.secretRef = undefined
}

/**
 * The host's credentials for the shadow viewer, if the vault holds any.
 *
 * `mstsc` carries none of its own: shadowing authenticates over RPC with the
 * identity of whoever started it, so a viewer started as the signed-in Windows
 * user is refused by any host that does not know that account. The account name
 * is qualified with the host for the same reason the session listing qualifies
 * it — a bare name means this machine's domain, not the target's.
 */
function shadowCredentials(
  profileId: string | undefined,
  host: string
): { username: string; password: string } | undefined {
  if (!profileId) return undefined

  const profile =
    sessionStore.getAll().sessions.find((s) => s.id === profileId) ??
    inventoryStore.findSession(profileId)
  if (!profile) return undefined

  const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
  const auth = resolveAuth(profile, profile.groupId, groups)
  const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
  if (!auth.username || !password) return undefined

  return { username: qualifyUser(auth.username, host), password }
}

function describeRule(rule: PortForwardRule): string {
  const src = `${rule.srcHost}:${rule.srcPort}`
  if (rule.type === 'dynamic') return `SOCKS ${src}`
  return `${rule.type} ${src} -> ${rule.dstHost}:${rule.dstPort}`
}

export function registerIpcHandlers(): void {
  // --- Vault ---
  ipcMain.handle(IPC.vaultStatus, () => vault.status())
  ipcMain.handle(IPC.vaultCreate, (_e, password: string) => {
    vault.create(password)
    return vault.status()
  })
  ipcMain.handle(IPC.vaultUnlock, (_e, password: string) => {
    try {
      vault.unlock(password)
      return { ok: true, status: vault.status() }
    } catch (err) {
      if (err instanceof WrongPasswordError) return { ok: false, error: err.message }
      throw err
    }
  })
  ipcMain.handle(IPC.vaultLock, () => {
    vault.lock()
    return vault.status()
  })
  ipcMain.handle(IPC.vaultChangePassword, (_e, current: string, next: string) => {
    try {
      vault.changePassword(current, next)
      return { ok: true }
    } catch (err) {
      if (err instanceof WrongPasswordError) return { ok: false, error: err.message }
      throw err
    }
  })

  // --- Trusted host keys ---
  ipcMain.handle(IPC.knownHostsList, () =>
    Object.entries(knownHosts.all()).map(([host, fingerprint]) => ({ host, fingerprint }))
  )
  ipcMain.handle(IPC.knownHostsRemove, (_e, host: string) => knownHosts.removeByKey(host))

  // --- Session store ---
  ipcMain.handle(IPC.storeLoad, () => sessionStore.getAll())
  ipcMain.handle(
    IPC.storeSaveSession,
    (_e, session: SessionProfile, secret?: string | null) => {
      if (secret === null) forgetSecret(session)
      else if (secret !== undefined) {
        session.secretRef = session.secretRef ?? randomUUID()
        vault.setSecret(session.secretRef, secret)
      }
      return sessionStore.saveSession(session)
    }
  )
  ipcMain.handle(IPC.storeDeleteSession, (_e, id: string) => {
    // The credential goes with the host. Left behind it would sit in the vault
    // for good, since nothing points at it any more.
    const session = sessionStore.getAll().sessions.find((s) => s.id === id)
    if (session) forgetSecret(session)
    sessionStore.deleteSession(id)
  })
  ipcMain.handle(IPC.storeReorderSessions, (_e, orderedIds: string[]) => {
    sessionStore.reorderSessions(orderedIds)
  })
  ipcMain.handle(IPC.storeSaveGroup, (_e, group: SessionGroup, secret?: string | null) => {
    if (secret === null) forgetSecret(group)
    else if (secret !== undefined) {
      group.secretRef = group.secretRef ?? randomUUID()
      vault.setSecret(group.secretRef, secret)
    }
    return sessionStore.saveGroup(group)
  })
  ipcMain.handle(IPC.storeDeleteGroup, (_e, id: string) => {
    // Only the group's own credential: hosts and subgroups are re-parented, not
    // deleted, and keep whatever they hold themselves.
    const group = sessionStore.getAll().groups.find((g) => g.id === id)
    if (group) forgetSecret(group)
    return sessionStore.deleteGroup(id)
  })

  // --- Inventory ---
  ipcMain.handle(IPC.inventoryGitAvailable, () => isGitAvailable())
  ipcMain.handle(IPC.inventoryList, () => ({
    sources: inventoryStore.sources(),
    overrides: inventoryStore.overrides(),
    trees: inventoryStore.allTrees()
  }))
  ipcMain.handle(IPC.inventorySaveSource, (_e, source: InventorySource) =>
    inventoryStore.saveSource(source)
  )
  ipcMain.handle(IPC.inventoryRemoveSource, (_e, id: string) => {
    // Removing a repository takes its overrides with it, so their credentials go
    // too — along with the repository's own.
    const source = inventoryStore.sources().find((s) => s.id === id)
    if (source) forgetSecret(source)
    for (const override of inventoryStore.overrides()) {
      if (override.nodeId.startsWith(`inv:${id}:`)) forgetSecret(override)
    }
    return inventoryStore.removeSource(id)
  })
  ipcMain.handle(IPC.inventorySync, (_e, id: string) => inventoryStore.sync(id))
  ipcMain.handle(IPC.inventorySyncAll, () => inventoryStore.syncAll())
  ipcMain.handle(
    IPC.inventorySaveOverride,
    (_e, override: InventoryOverride, secret?: string | null) => {
      if (secret === null) forgetSecret(override)
      else if (secret !== undefined) {
        override.secretRef = override.secretRef ?? randomUUID()
        vault.setSecret(override.secretRef, secret)
      }
      return inventoryStore.saveOverride(override)
    }
  )
  ipcMain.handle(IPC.inventoryClearOverride, (_e, nodeId: string) => {
    const override = inventoryStore.overrides().find((o) => o.nodeId === nodeId)
    if (override) forgetSecret(override)
    return inventoryStore.clearOverride(nodeId)
  })

  // --- Backup ---
  ipcMain.handle(IPC.backupExport, (_e, includeSecrets: boolean, password?: string) =>
    exportToFile(focusedWin(), includeSecrets, password)
  )
  ipcMain.handle(IPC.backupImport, (_e, password?: string) =>
    importFromFile(focusedWin(), password)
  )

  // --- Snippets ---
  ipcMain.handle(IPC.snippetsList, () => snippetStore.list())
  ipcMain.handle(IPC.snippetsSave, (_e, snippet: Snippet) => snippetStore.save(snippet))
  ipcMain.handle(IPC.snippetsDelete, (_e, id: string) => snippetStore.remove(id))

  ipcMain.handle(IPC.collectionsList, () => collectionStore.list())
  ipcMain.handle(IPC.collectionsSave, (_e, collection: HostCollection) =>
    collectionStore.save(collection)
  )
  ipcMain.handle(IPC.collectionsDelete, (_e, id: string) => collectionStore.remove(id))
  ipcMain.handle(IPC.collectionsReorder, (_e, ids: string[]) => collectionStore.reorder(ids))

  // --- SSH ---
  ipcMain.handle(
    IPC.sshConnect,
    async (_e, sessionId: string, cols: number, rows: number) => {
      // Inventory hosts live in their own store and aren't saved as sessions.
      const profile =
        sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
        inventoryStore.findSession(sessionId)
      if (!profile) throw new Error('Unknown session')
      const win = focusedWin()
      const connectionId = await sshManager.connectProfile(win, profile, cols, rows)
      // Bring the profile's tunnels up automatically; a failure here (busy port,
      // server refusing a remote bind) must not take the shell down with it.
      for (const rule of profile.portForwards) {
        try {
          await portForwardManager.start(connectionId, rule)
        } catch (err) {
          if (!win.isDestroyed()) {
            win.webContents.send(
              `${IPC.sshError}:${connectionId}`,
              `tunnel ${describeRule(rule)} failed: ${(err as Error).message}`
            )
          }
        }
      }
      return { connectionId }
    }
  )
  ipcMain.handle(
    IPC.sshQuickConnect,
    async (_e, params: QuickConnectParams, cols: number, rows: number) => {
      const connectionId = await sshManager.connectQuick(focusedWin(), params, cols, rows)
      return { connectionId }
    }
  )
  ipcMain.handle(IPC.sshSetFollowCwd, (_e, connectionId: string, enabled: boolean) =>
    sshManager.setFollowCwd(connectionId, enabled)
  )
  ipcMain.handle(IPC.sshGetFollowCwd, (_e, connectionId: string) =>
    sshManager.isFollowingCwd(connectionId)
  )
  ipcMain.handle(IPC.sshDisconnect, (_e, connectionId: string) => {
    remoteEdit.stopAllFor(connectionId)
    sftpManager.releaseConnection(connectionId)
    portForwardManager.stopAllForConnection(connectionId)
    remoteMonitor.stop(connectionId)
    sshManager.disconnect(connectionId)
  })
  ipcMain.on(IPC.sshWrite, (_e, connectionId: string, data: string) => {
    sshManager.write(connectionId, data)
  })
  ipcMain.on(IPC.sshResize, (_e, connectionId: string, cols: number, rows: number) => {
    sshManager.resize(connectionId, cols, rows)
  })

  // --- SFTP ---
  ipcMain.handle(IPC.sftpList, (_e, connectionId: string, path: string) =>
    sftpManager.list(connectionId, path)
  )
  ipcMain.handle(
    IPC.sftpPlanUpload,
    (_e, connectionId: string, localPath: string, remoteParent: string) =>
      sftpManager.planUpload(connectionId, localPath, remoteParent)
  )
  ipcMain.handle(
    IPC.sftpPlanDownload,
    (_e, connectionId: string, remotePath: string, localTarget: string, exactFile?: boolean) =>
      sftpManager.planDownload(connectionId, remotePath, localTarget, exactFile)
  )
  ipcMain.handle(
    IPC.sftpPlanRelay,
    (
      _e,
      srcConnectionId: string,
      srcPath: string,
      dstConnectionId: string,
      destParent: string
    ) => sftpManager.planRelay(srcConnectionId, srcPath, dstConnectionId, destParent)
  )
  ipcMain.handle(
    IPC.sftpRunPlan,
    (
      _e,
      connectionId: string,
      plan: TransferPlan,
      decisions: TransferDecisions,
      destConnectionId?: string
    ) =>
      sftpManager.runPlan(
        connectionId,
        plan,
        decisions,
        (transferred, total, path) => {
          reportTransfer(connectionId, path, transferred, total)
          // A relay concerns two panels, and the one the files were dropped on
          // is the one the user is watching. Both get the bar.
          if (destConnectionId && destConnectionId !== connectionId) {
            reportTransfer(destConnectionId, path, transferred, total)
          }
        },
        destConnectionId
      )
  )
  ipcMain.handle(
    IPC.sftpCompare,
    (_e, connectionId: string, remotePath: string, localPath: string) =>
      sftpManager.compareWithLocal(connectionId, remotePath, localPath)
  )
  ipcMain.handle(IPC.sftpRealpath, (_e, connectionId: string, path: string) =>
    sftpManager.realpath(connectionId, path)
  )
  ipcMain.handle(IPC.sftpStat, (_e, connectionId: string, path: string) =>
    sftpManager.statPath(connectionId, path)
  )
  ipcMain.handle(IPC.sftpMkdir, (_e, connectionId: string, path: string) =>
    sftpManager.mkdir(connectionId, path)
  )
  ipcMain.handle(
    IPC.sftpDelete,
    (_e, connectionId: string, path: string, isDirectory: boolean) =>
      sftpManager.delete(connectionId, path, isDirectory)
  )
  ipcMain.handle(
    IPC.sftpRename,
    (_e, connectionId: string, oldPath: string, newPath: string) =>
      sftpManager.rename(connectionId, oldPath, newPath)
  )
  ipcMain.handle(
    IPC.sftpDownload,
    (_e, connectionId: string, remotePath: string, localPath: string) =>
      sftpManager.download(connectionId, remotePath, localPath, (transferred, total) =>
        reportTransfer(connectionId, remotePath, transferred, total)
      )
  )
  ipcMain.handle(
    IPC.sftpUpload,
    (_e, connectionId: string, localPath: string, remotePath: string) =>
      sftpManager.upload(connectionId, localPath, remotePath, (transferred, total) =>
        reportTransfer(connectionId, remotePath, transferred, total)
      )
  )
  ipcMain.handle(
    IPC.sftpDownloadDir,
    (_e, connectionId: string, remotePath: string, localDir: string) =>
      sftpManager.downloadDirectory(connectionId, remotePath, localDir, (t, total, path) =>
        reportTransfer(connectionId, path, t, total)
      )
  )
  ipcMain.handle(
    IPC.sftpUploadPath,
    (_e, connectionId: string, localPath: string, remoteParent: string) =>
      sftpManager.uploadPath(connectionId, localPath, remoteParent, (t, total, path) =>
        reportTransfer(connectionId, path, t, total)
      )
  )

  ipcMain.handle(
    IPC.sftpEdit,
    (_e, connectionId: string, remotePath: string, editorCommand?: string) =>
      remoteEdit.open(focusedWin(), connectionId, remotePath, editorCommand)
  )
  ipcMain.handle(IPC.sftpStopEdit, (_e, connectionId: string, remotePath: string) =>
    remoteEdit.stop(connectionId, remotePath)
  )

  // --- Graphical sessions ---
  ipcMain.handle(IPC.rdpReserve, () => rdpGateway.reserve())

  /**
   * The login for one host, resolved through the same inheritance chain SSH
   * uses, so a group can state it once.
   *
   * This is the only place a stored secret leaves the main process, and it is
   * deliberately narrow: it answers for one named host and returns nothing else,
   * so the window cannot walk the vault. It exists because an RDP client
   * authenticates where it draws — CredSSP happens in the WebAssembly module —
   * and there is no way to do that from here without implementing CredSSP too.
   */
  ipcMain.handle(IPC.rdpCredentials, (_e, sessionId: string) => {
    const profile =
      sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
      inventoryStore.findSession(sessionId)
    if (!profile) throw new Error('Unknown session')
    if (protocolOf(profile) !== 'rdp') throw new Error('That host is not an RDP host')

    const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
    const auth = resolveAuth(profile, profile.groupId, groups)
    return {
      username: auth.username,
      // Empty rather than absent when nothing is stored: the window then asks,
      // which is also the path for people who deliberately save no password.
      password: auth.secretRef ? vault.getSecret(auth.secretRef) ?? '' : ''
    }
  })

  /**
   * Takes a host id rather than an address so the credentials can be resolved
   * here: `qwinsta` signs in as the Windows account running this app, which is
   * the wrong one for any host outside its domain, and the right one is already
   * in the vault. The password is used and dropped without reaching the window.
   */
  ipcMain.handle(IPC.shadowStart, (_e, request: ShadowRequest) => {
    const win = focusedWin()
    if (!win) throw new Error('No window to draw into')
    return shadowHostBridge.start(win, request, shadowCredentials(request.profileId, request.host))
  })
  ipcMain.on(IPC.shadowPlace, (_e, id: string, rect: PaneRect) =>
    shadowHostBridge.place(id, rect)
  )
  ipcMain.on(IPC.shadowVisible, (_e, id: string, visible: boolean) =>
    shadowHostBridge.setVisible(id, visible)
  )
  ipcMain.handle(IPC.shadowStop, (_e, id: string) => shadowHostBridge.stop(id))

  ipcMain.handle(IPC.rdpListSessions, (_e, sessionId: string) => {
    const profile =
      sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
      inventoryStore.findSession(sessionId)
    if (!profile) throw new Error('Unknown session')

    const groups = [...sessionStore.getAll().groups, ...inventoryStore.allGroups()]
    const auth = resolveAuth(profile, profile.groupId, groups)
    const password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    return listSessions(
      profile.host,
      password ? { username: auth.username, password } : undefined
    )
  })
  ipcMain.handle(
    IPC.rdpShadow,
    (_e, host: string, sessionId: number, options: { control: boolean; skipPrompt: boolean }) =>
      shadowSession(host, sessionId, options)
  )

  // --- Remote monitoring ---
  ipcMain.handle(IPC.monitorStart, (_e, connectionId: string) => {
    remoteMonitor.start(focusedWin(), connectionId)
  })
  ipcMain.handle(IPC.monitorStop, (_e, connectionId: string) => {
    remoteMonitor.stop(connectionId)
  })

  // --- Port forwarding ---
  ipcMain.handle(IPC.pfStart, (_e, connectionId: string, rule: PortForwardRule) =>
    portForwardManager.start(connectionId, rule)
  )
  ipcMain.handle(IPC.pfStop, (_e, connectionId: string, ruleId: string) =>
    portForwardManager.stop(connectionId, ruleId)
  )
  ipcMain.handle(IPC.pfStatus, (_e, connectionId: string) =>
    portForwardManager.listActive(connectionId)
  )

  // --- Import ---
  ipcMain.handle(IPC.sshConfigRead, () => readSshConfigHosts())

  // --- Session logs ---
  ipcMain.handle(IPC.logsReveal, async () => {
    const dir = join(app.getPath('userData'), 'logs')
    // The directory only appears once a session with logging enabled has run.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })

  // --- Dialogs ---
  ipcMain.handle(IPC.dialogPickPrivateKey, async () => {
    const res = await dialog.showOpenDialog(focusedWin(), {
      properties: ['openFile'],
      title: 'Select private key'
    })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle(IPC.dialogPickSavePath, async (_e, defaultName: string) => {
    const res = await dialog.showSaveDialog(focusedWin(), { defaultPath: defaultName })
    return res.canceled ? undefined : res.filePath
  })
  ipcMain.handle(IPC.dialogPickOpenPath, async () => {
    const res = await dialog.showOpenDialog(focusedWin(), { properties: ['openFile'] })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle(IPC.dialogPickDirectory, async () => {
    const res = await dialog.showOpenDialog(focusedWin(), {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a destination folder'
    })
    return res.canceled ? undefined : res.filePaths[0]
  })
}
