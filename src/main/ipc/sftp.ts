import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { TransferDecisions, TransferPlan } from '../../shared/types'
import { remoteEdit } from '../ssh/RemoteEdit'
import { sftpManager } from '../ssh/SFTPManager'
import { focusedWin } from './win'

/** The file browser: listing, transfers, and editing a remote file locally. */

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

}
