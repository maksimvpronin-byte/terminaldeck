import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { PortForwardRule, QuickConnectParams } from '../../shared/types'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import { portForwardManager } from '../ssh/PortForwardManager'
import { remoteEdit } from '../ssh/RemoteEdit'
import { remoteMonitor } from '../ssh/RemoteMonitor'
import { sftpManager } from '../ssh/SFTPManager'
import { sshManager } from '../ssh/SSHManager'
import { readSshConfigHosts } from '../ssh/sshConfig'
import { credentialStore } from '../store/CredentialStore'
import { sessionStore } from '../store/SessionStore'
import { focusedWin } from './win'

/** Shell sessions, the tunnels beside them, monitoring, and `~/.ssh/config`. */

function describeRule(rule: PortForwardRule): string {
  const src = `${rule.srcHost}:${rule.srcPort}`
  if (rule.type === 'dynamic') return `SOCKS ${src}`
  return `${rule.type} ${src} -> ${rule.dstHost}:${rule.dstPort}`
}

export function registerSshHandlers(): void {
  // --- SSH ---
  ipcMain.handle(
    IPC.sshConnect,
    async (
      _e,
      sessionId: string,
      cols: number,
      rows: number,
      /**
       * A stored login to use in place of the host's own, for this session
       * only. Nothing is written back: the host keeps the account it is saved
       * with, however many times it is reached as somebody else.
       */
      credentialId?: string
    ) => {
      // Hosts from a repository live in their own store and aren't saved as
      // sessions — whether they came from an Inventory source or from a folder
      // on the Sessions tab that mirrors one.
      const profile =
        sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
        inventoryStore.findSession(sessionId) ??
        gitFolderStore.findSession(sessionId)
      if (!profile) throw new Error('Unknown session')
      // An id that names nothing is refused rather than quietly ignored: the
      // account was asked for, and connecting as the host's own instead is a
      // different connection from the one somebody chose.
      const credential = credentialId ? credentialStore.find(credentialId) : undefined
      if (credentialId && !credential) throw new Error('That saved account no longer exists')
      const win = focusedWin()
      const connectionId = await sshManager.connectProfile(win, profile, cols, rows, credential)
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
  ipcMain.on(IPC.sshAck, (_e, connectionId: string, bytes: number) => {
    sshManager.acknowledge(connectionId, bytes)
  })
  ipcMain.on(IPC.sshResize, (_e, connectionId: string, cols: number, rows: number) => {
    sshManager.resize(connectionId, cols, rows)
  })


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

}
