import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { TransferDecisions, TransferPlan } from '../../shared/types'
import { remoteEdit } from '../ssh/RemoteEdit'
import { sftpManager } from '../ssh/SFTPManager'
import { requireUnlocked } from '../vault/locked'
import { focusedWin } from './win'

/** The file browser: listing, transfers, and editing a remote file locally. */

/**
 * Every channel in this file, refused while the vault is locked.
 *
 * Browsing a remote filesystem is reading somebody's data, and a locked
 * application must not do it — not even down a connection that was open before
 * the lock, because the connection is not what the lock is about. Written as a
 * wrapper rather than a line in each of seventeen handlers: one of them would
 * eventually be added without it, and the one that was missed would be the
 * whole of the hole.
 *
 * The guard is here rather than inside `SFTPManager` on purpose. This is the
 * boundary with the window — the place where somebody is asking for something —
 * while the manager is also used by work already in flight, such as the upload
 * that follows a save in an external editor. Locking should refuse a new
 * request, not throw away an edit somebody made before they walked away.
 */
function handleWhileUnlocked(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown
): void {
  ipcMain.handle(channel, (event, ...args) => {
    requireUnlocked()
    return handler(event, ...(args as never[]))
  })
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

export function registerSftpHandlers(): void {
  // --- SFTP ---
  handleWhileUnlocked(IPC.sftpList, (_e, connectionId: string, path: string) =>
    sftpManager.list(connectionId, path)
  )
  handleWhileUnlocked(
    IPC.sftpPlanUpload,
    (_e, connectionId: string, localPath: string, remoteParent: string) =>
      sftpManager.planUpload(connectionId, localPath, remoteParent)
  )
  handleWhileUnlocked(
    IPC.sftpPlanDownload,
    (_e, connectionId: string, remotePath: string, localTarget: string, exactFile?: boolean) =>
      sftpManager.planDownload(connectionId, remotePath, localTarget, exactFile)
  )
  handleWhileUnlocked(
    IPC.sftpPlanRelay,
    (_e, srcConnectionId: string, srcPath: string, dstConnectionId: string, destParent: string) =>
      sftpManager.planRelay(srcConnectionId, srcPath, dstConnectionId, destParent)
  )
  handleWhileUnlocked(
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
  handleWhileUnlocked(
    IPC.sftpCompare,
    (_e, connectionId: string, remotePath: string, localPath: string) =>
      sftpManager.compareWithLocal(connectionId, remotePath, localPath)
  )
  handleWhileUnlocked(IPC.sftpRealpath, (_e, connectionId: string, path: string) =>
    sftpManager.realpath(connectionId, path)
  )
  handleWhileUnlocked(IPC.sftpStat, (_e, connectionId: string, path: string) =>
    sftpManager.statPath(connectionId, path)
  )
  handleWhileUnlocked(IPC.sftpMkdir, (_e, connectionId: string, path: string) =>
    sftpManager.mkdir(connectionId, path)
  )
  handleWhileUnlocked(
    IPC.sftpDelete,
    (_e, connectionId: string, path: string, isDirectory: boolean) =>
      sftpManager.delete(connectionId, path, isDirectory)
  )
  handleWhileUnlocked(
    IPC.sftpRename,
    (_e, connectionId: string, oldPath: string, newPath: string) =>
      sftpManager.rename(connectionId, oldPath, newPath)
  )
  handleWhileUnlocked(
    IPC.sftpDownload,
    (_e, connectionId: string, remotePath: string, localPath: string) =>
      sftpManager.download(connectionId, remotePath, localPath, (transferred, total) =>
        reportTransfer(connectionId, remotePath, transferred, total)
      )
  )
  handleWhileUnlocked(
    IPC.sftpUpload,
    (_e, connectionId: string, localPath: string, remotePath: string) =>
      sftpManager.upload(connectionId, localPath, remotePath, (transferred, total) =>
        reportTransfer(connectionId, remotePath, transferred, total)
      )
  )
  handleWhileUnlocked(
    IPC.sftpDownloadDir,
    (_e, connectionId: string, remotePath: string, localDir: string) =>
      sftpManager.downloadDirectory(connectionId, remotePath, localDir, (t, total, path) =>
        reportTransfer(connectionId, path, t, total)
      )
  )
  handleWhileUnlocked(
    IPC.sftpUploadPath,
    (_e, connectionId: string, localPath: string, remoteParent: string) =>
      sftpManager.uploadPath(connectionId, localPath, remoteParent, (t, total, path) =>
        reportTransfer(connectionId, path, t, total)
      )
  )

  handleWhileUnlocked(
    IPC.sftpEdit,
    (_e, connectionId: string, remotePath: string, editorCommand?: string) =>
      remoteEdit.open(focusedWin(), connectionId, remotePath, editorCommand)
  )
  handleWhileUnlocked(IPC.sftpStopEdit, (_e, connectionId: string, remotePath: string) =>
    remoteEdit.stop(connectionId, remotePath)
  )
}
