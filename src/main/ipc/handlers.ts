import { ipcMain, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/ipc-channels'
import { vault, WrongPasswordError } from '../vault/Vault'
import { sessionStore } from '../store/SessionStore'
import { snippetStore } from '../store/SnippetStore'
import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'
import { portForwardManager } from '../ssh/PortForwardManager'
import { readSshConfigHosts } from '../ssh/sshConfig'
import { knownHosts } from '../ssh/KnownHosts'
import type {
  SessionProfile,
  SessionGroup,
  QuickConnectParams,
  PortForwardRule,
  Snippet
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
    (_e, session: SessionProfile, secret?: string) => {
      if (secret !== undefined) {
        session.secretRef = session.secretRef ?? randomUUID()
        vault.setSecret(session.secretRef, secret)
      }
      return sessionStore.saveSession(session)
    }
  )
  ipcMain.handle(IPC.storeDeleteSession, (_e, id: string) => {
    sessionStore.deleteSession(id)
  })
  ipcMain.handle(IPC.storeSaveGroup, (_e, group: SessionGroup) => sessionStore.saveGroup(group))
  ipcMain.handle(IPC.storeDeleteGroup, (_e, id: string) => sessionStore.deleteGroup(id))

  // --- Snippets ---
  ipcMain.handle(IPC.snippetsList, () => snippetStore.list())
  ipcMain.handle(IPC.snippetsSave, (_e, snippet: Snippet) => snippetStore.save(snippet))
  ipcMain.handle(IPC.snippetsDelete, (_e, id: string) => snippetStore.remove(id))

  // --- SSH ---
  ipcMain.handle(
    IPC.sshConnect,
    async (_e, sessionId: string, cols: number, rows: number) => {
      const profile = sessionStore.getAll().sessions.find((s) => s.id === sessionId)
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
  ipcMain.handle(IPC.sshDisconnect, (_e, connectionId: string) => {
    sftpManager.releaseConnection(connectionId)
    portForwardManager.stopAllForConnection(connectionId)
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
}
