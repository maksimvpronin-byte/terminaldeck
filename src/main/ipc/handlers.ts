import { ipcMain, BrowserWindow, dialog, shell, app } from 'electron'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
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
import { rdpGateway, type RdpRoute } from '../rdp/Gateway'
import { listSessions, shadowSession } from '../rdp/WinSessions'
import {
  shadowHostBridge,
  type PaneRect,
  type ShadowRequest
} from '../rdp/ShadowHostBridge'
import { resolveAuth } from '../../shared/authResolution'
import { resolveRdp } from '../../shared/rdpResolution'
import { qualifyUser } from '../../shared/winSessions'
import { protocolOf } from '../../shared/protocols'
import { readSshConfigHosts } from '../ssh/sshConfig'
import { knownHosts } from '../ssh/KnownHosts'
import { trustedCertificates } from '../rdp/CertificateTrust'
import { inventoryStore } from '../inventory/InventoryStore'
import { isGitAvailable } from '../inventory/GitRepo'
import type {
  SessionProfile,
  SessionGroup,
  RdpView,
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
  forgetSecretAt(item, 'secretRef')
}

/**
 * The same, for whichever reference is named — a host holds two, its own login
 * and the one its gateway wants, and both have to be droppable.
 */
function forgetSecretAt<K extends string>(
  item: Partial<Record<K, string | undefined>>,
  field: K
): void {
  const ref = item[field]
  if (ref && vault.status().unlocked) vault.deleteSecret(ref)
  item[field] = undefined
}

/**
 * Stores a typed secret, mints a reference for it if there is none, or drops
 * the stored one when the caller passes null. Undefined leaves it as it was,
 * which is what saving a dialog nobody typed a password into means.
 */
function applySecret<K extends string>(
  item: Partial<Record<K, string | undefined>>,
  field: K,
  secret: string | null | undefined
): void {
  if (secret === null) forgetSecretAt(item, field)
  else if (secret !== undefined) {
    const ref = item[field] ?? randomUUID()
    item[field] = ref
    vault.setSecret(ref, secret)
  }
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

/**
 * A host, wherever it is saved, and the groups its settings inherit along.
 *
 * Hand-made sessions and inventory hosts resolve identically, and every RDP
 * handler needs both halves, so the lookup lives in one place.
 */
function findHost(
  sessionId: string
): { profile: SessionProfile; groups: SessionGroup[] } | undefined {
  const profile =
    sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
    inventoryStore.findSession(sessionId)
  if (!profile) return undefined
  return { profile, groups: [...sessionStore.getAll().groups, ...inventoryStore.allGroups()] }
}

/**
 * How one host is to be reached, gateway password included.
 *
 * Resolved here and kept here. The window is handed a loopback address and
 * nothing else, so a gateway credential — unlike the host's own, which CredSSP
 * forces into the renderer — never leaves the main process at all.
 */
function routeFor(sessionId: string | undefined): RdpRoute {
  if (!sessionId) return {}
  const found = findHost(sessionId)
  if (!found) return {}

  const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
  if (!rdp.gatewayHost) return {}

  // A gateway with no login of its own is given the host's, which is what
  // "use my connection credentials" means in every other client.
  const auth = resolveAuth(found.profile, found.profile.groupId, found.groups)
  const username = rdp.gatewayUsername || auth.username
  const secretRef = rdp.gatewayUsername ? rdp.gatewaySecretRef : auth.secretRef

  return {
    gateway: {
      host: rdp.gatewayHost,
      port: rdp.gatewayPort,
      username,
      password: secretRef ? vault.getSecret(secretRef) ?? '' : '',
      bypassLocal: rdp.gatewayBypassLocal
    }
  }
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
  ipcMain.handle(IPC.knownCertificatesList, () =>
    Object.entries(trustedCertificates.all()).map(([host, fingerprint]) => ({ host, fingerprint }))
  )
  ipcMain.handle(IPC.knownCertificatesRemove, (_e, host: string) =>
    trustedCertificates.removeByKey(host)
  )

  // --- Session store ---
  ipcMain.handle(IPC.storeLoad, () => sessionStore.getAll())
  ipcMain.handle(
    IPC.storeSaveSession,
    (_e, session: SessionProfile, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(session, 'secretRef', secret)
      applySecret(session, 'gatewaySecretRef', gatewaySecret)
      return sessionStore.saveSession(session)
    }
  )
  ipcMain.handle(IPC.storeDeleteSession, (_e, id: string) => {
    // The credential goes with the host. Left behind it would sit in the vault
    // for good, since nothing points at it any more.
    const session = sessionStore.getAll().sessions.find((s) => s.id === id)
    if (session) {
      forgetSecret(session)
      forgetSecretAt(session, 'gatewaySecretRef')
    }
    sessionStore.deleteSession(id)
  })
  ipcMain.handle(IPC.storeReorderSessions, (_e, orderedIds: string[]) => {
    sessionStore.reorderSessions(orderedIds)
  })
  ipcMain.handle(
    IPC.storeSaveGroup,
    (_e, group: SessionGroup, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(group, 'secretRef', secret)
      applySecret(group, 'gatewaySecretRef', gatewaySecret)
      return sessionStore.saveGroup(group)
    }
  )
  ipcMain.handle(IPC.storeDeleteGroup, (_e, id: string) => {
    // Only the group's own credential: hosts and subgroups are re-parented, not
    // deleted, and keep whatever they hold themselves.
    const group = sessionStore.getAll().groups.find((g) => g.id === id)
    if (group) {
      forgetSecret(group)
      forgetSecretAt(group, 'gatewaySecretRef')
    }
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
    (
      _e,
      override: InventoryOverride,
      secret?: string | null,
      gatewaySecret?: string | null
    ) => {
      applySecret(override, 'secretRef', secret)
      applySecret(override, 'gatewaySecretRef', gatewaySecret)
      return inventoryStore.saveOverride(override)
    }
  )
  ipcMain.handle(IPC.inventoryClearOverride, (_e, nodeId: string) => {
    const override = inventoryStore.overrides().find((o) => o.nodeId === nodeId)
    if (override) {
      forgetSecret(override)
      forgetSecretAt(override, 'gatewaySecretRef')
    }
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
  /**
   * Reserves a single-use loopback address, and settles behind it how the
   * session will actually be routed. Takes a host id rather than a route so the
   * gateway and its password are resolved here; see routeFor.
   */
  ipcMain.handle(IPC.rdpReserve, (_e, sessionId?: string) =>
    rdpGateway.reserve(routeFor(sessionId))
  )

  ipcMain.handle(
    IPC.rdpTracing,
    () => process.env.NODE_ENV === 'development' || process.env.TERMINALDECK_RDP_TRACE === '1'
  )

  ipcMain.handle(IPC.rdpFailure, (_e, proxyAddress: string) =>
    rdpGateway.failureFor(proxyAddress)
  )

  /**
   * The desktop settings for one host: how big it should be, and how the
   * keyboard behaves. Everything the window legitimately needs to draw a
   * session, and deliberately nothing about where that session is routed.
   */
  ipcMain.handle(IPC.rdpSettings, (_e, sessionId: string) => {
    const found = findHost(sessionId)
    if (!found) throw new Error('Unknown session')
    const rdp = resolveRdp(found.profile, found.profile.groupId, found.groups)
    const view: RdpView = {
      resolution: rdp.resolution,
      desktopWidth: rdp.desktopWidth,
      desktopHeight: rdp.desktopHeight,
      pixelBudget: rdp.pixelBudget,
      commandAsControl: rdp.commandAsControl
    }
    return view
  })

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
   * here: the query signs in as the Windows account running this app, which is
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

  /**
   * Where to put a file copied out of a remote desktop, and then puts it there.
   *
   * Asked and written in one call so the bytes are never left in the window
   * waiting on an answer, and so a cancelled dialog leaves nothing behind. Given
   * a folder it writes straight into it, which is how a batch is saved without
   * asking about every file in it.
   *
   * The name is stripped to its last component first. It was chosen on the far
   * machine, and a name is all it is allowed to be: `..\..\autorun.inf` reaching
   * a folder of its own choosing is exactly what a hostile session would send.
   */
  ipcMain.handle(IPC.fileSaveAs, async (_e, name: string, bytes: Uint8Array, folder?: string) => {
    const safe = basename(name.replace(/\\/g, '/')) || 'file'

    let target: string
    if (folder) {
      target = join(folder, safe)
    } else {
      const res = await dialog.showSaveDialog(focusedWin(), {
        defaultPath: safe,
        title: 'Save the file from the remote desktop'
      })
      if (res.canceled || !res.filePath) return undefined
      target = res.filePath
    }

    await writeFile(target, Buffer.from(bytes))
    return target
  })
}
