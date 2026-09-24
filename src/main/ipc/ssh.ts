import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { PortForwardRule, QuickConnectParams } from '../../shared/types'
import { portForwardManager } from '../ssh/PortForwardManager'
import { remoteEdit } from '../ssh/RemoteEdit'
import { remoteMonitor } from '../ssh/RemoteMonitor'
import { sftpManager } from '../ssh/SFTPManager'
import { sshManager } from '../ssh/SSHManager'
import { readSshConfigHosts } from '../ssh/sshConfig'
import { credentialStore } from '../store/CredentialStore'
import { findProfile } from '../store/hosts'
import { focusedWin } from './win'
import {
  MAX_TERMINAL_WRITE,
  checkForwardRule,
  checkQuickConnect,
  isOptionalString,
  isString,
  isTerminalSize
} from './guard'

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
      credentialId?: string,
      /** Names the attempt, so the pane can give up on it; see sshCancelConnect. */
      attemptId?: string
    ) => {
      isString(sessionId, 'sessionId')
      isTerminalSize(cols, rows)
      isOptionalString(credentialId, 'credentialId')
      // Hosts from a repository live in their own store and aren't saved as
      // sessions — whether they came from an Inventory source or from a folder
      // on the Sessions tab that mirrors one.
      const profile = findProfile(sessionId)
      if (!profile) throw new Error('Unknown session')
      // An id that names nothing is refused rather than quietly ignored: the
      // account was asked for, and connecting as the host's own instead is a
      // different connection from the one somebody chose.
      const credential = credentialId ? credentialStore.find(credentialId) : undefined
      if (credentialId && !credential) throw new Error('That saved account no longer exists')
      const win = focusedWin()
      const connectionId = await sshManager.connectProfile(
        win,
        profile,
        cols,
        rows,
        credential,
        typeof attemptId === 'string' ? attemptId : undefined
      )
      // Bring the profile's tunnels up automatically; a failure here (busy port,
      // server refusing a remote bind) must not take the shell down with it.
      for (const rule of profile.portForwards) {
        try {
          await portForwardManager.start(connectionId, rule)
        } catch (err) {
          sshManager.reportError(
            win,
            connectionId,
            `tunnel ${describeRule(rule)} failed: ${(err as Error).message}`
          )
        }
      }
      return { connectionId }
    }
  )
  ipcMain.handle(
    IPC.sshQuickConnect,
    async (_e, params: QuickConnectParams, cols: number, rows: number, attemptId?: string) => {
      checkQuickConnect(params)
      isTerminalSize(cols, rows)
      const connectionId = await sshManager.connectQuick(
        focusedWin(),
        params,
        cols,
        rows,
        typeof attemptId === 'string' ? attemptId : undefined
      )
      return { connectionId }
    }
  )
  ipcMain.handle(IPC.sshSetFollowCwd, (_e, connectionId: string, enabled: boolean) =>
    sshManager.setFollowCwd(connectionId, enabled)
  )
  ipcMain.handle(IPC.sshGetFileAccess, (_e, connectionId: string) =>
    sshManager.getFileAccess(connectionId)
  )
  ipcMain.handle(IPC.sshGetFollowCwd, (e, connectionId: string) => {
    // Asked by a file panel as it opens, after it has subscribed: the answer
    // comes with where the shell is now, if it has said.
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) setImmediate(() => !win.isDestroyed() && sshManager.replayCwd(win, connectionId))
    return sshManager.isFollowingCwd(connectionId)
  })
  /**
   * Everything hung off a connection, let go of.
   *
   * Registered as an observer rather than called from the disconnect handler,
   * because a session ends two ways and only one of them came through here. A
   * shell that ended on its own — `exit`, or a link that dropped — left the
   * SFTP channels open, the remote edits watched, the monitor polling and, the
   * one with teeth, the forwarded ports listening: bound to nothing, refusing
   * to forward, and unavailable to the next connection or to anything else on
   * the machine.
   */
  sshManager.onClosed((connectionId: string) => {
    remoteEdit.stopAllFor(connectionId)
    sftpManager.releaseConnection(connectionId)
    portForwardManager.stopAllForConnection(connectionId)
    remoteMonitor.stop(connectionId)
  })

  ipcMain.handle(IPC.sshDisconnect, (_e, connectionId: string) => {
    // The release above runs from inside this, for both ways out.
    sshManager.disconnect(connectionId)
  })

  ipcMain.on(IPC.sshCancelConnect, (_e, attemptId: unknown) => {
    if (typeof attemptId === 'string') sshManager.cancelConnect(attemptId)
  })

  ipcMain.on(IPC.sshReady, (_e, connectionId: string) => {
    sshManager.markReady(focusedWin(), connectionId)
  })
  /*
   * These three arrive many times a second and answer nothing, so a message of
   * the wrong shape is dropped rather than thrown: there is nobody to throw to.
   */
  ipcMain.on(IPC.sshWrite, (_e, connectionId: unknown, data: unknown) => {
    if (typeof connectionId !== 'string' || typeof data !== 'string') return
    if (data.length > MAX_TERMINAL_WRITE) return
    sshManager.write(connectionId, data)
  })
  ipcMain.on(IPC.sshAck, (_e, connectionId: unknown, bytes: unknown) => {
    if (typeof connectionId !== 'string' || typeof bytes !== 'number') return
    if (!Number.isFinite(bytes) || bytes < 0) return
    sshManager.acknowledge(connectionId, bytes)
  })
  ipcMain.on(IPC.sshResize, (_e, connectionId: unknown, cols: unknown, rows: unknown) => {
    if (typeof connectionId !== 'string') return
    try {
      isTerminalSize(cols, rows)
    } catch {
      return
    }
    sshManager.resize(connectionId, cols as number, rows as number)
  })

  // --- Remote monitoring ---
  ipcMain.handle(IPC.monitorStart, (_e, connectionId: string) => {
    remoteMonitor.start(focusedWin(), connectionId)
  })
  ipcMain.handle(IPC.monitorStop, (_e, connectionId: string) => {
    remoteMonitor.stop(connectionId)
  })

  // --- Port forwarding ---
  ipcMain.handle(IPC.pfStart, (_e, connectionId: string, rule: PortForwardRule) => {
    isString(connectionId, 'connectionId')
    checkForwardRule(rule)
    return portForwardManager.start(connectionId, rule)
  })
  ipcMain.handle(IPC.pfStop, (_e, connectionId: string, ruleId: string) =>
    portForwardManager.stop(connectionId, ruleId)
  )
  ipcMain.handle(IPC.pfStatus, (_e, connectionId: string) =>
    portForwardManager.listActive(connectionId)
  )

  // --- Import ---
  ipcMain.handle(IPC.sshConfigRead, () => readSshConfigHosts())
}
