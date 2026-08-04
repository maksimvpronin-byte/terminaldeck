import { BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
import type { UpdateState } from '../shared/types'

let state: UpdateState = { status: 'idle' }
/** macOS re-creates the window on activate; handlers must only be bound once. */
let registered = false

function publish(win: BrowserWindow, next: UpdateState): void {
  state = next
  if (!win.isDestroyed()) win.webContents.send(IPC.updateState, next)
}

export function registerUpdater(win: BrowserWindow): void {
  if (registered) return
  registered = true

  ipcMain.handle(IPC.updateGetState, () => state)

  ipcMain.handle(IPC.updateDownload, async () => {
    publish(win, { status: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  })

  ipcMain.handle(IPC.updateInstall, () => {
    // Quits the app and relaunches into the new version.
    autoUpdater.quitAndInstall()
  })

  // In dev there is no packaged app to replace, and electron-updater throws.
  if (is.dev) return

  // Downloads are explicit: an SSH client should not restart itself mid-session.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    publish(win, { status: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    publish(win, { status: 'idle' })
  })
  autoUpdater.on('download-progress', (p) => {
    publish(win, { status: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    publish(win, { status: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    publish(win, { status: 'error', message: err.message })
  })

  autoUpdater.checkForUpdates().catch((err: Error) => {
    publish(win, { status: 'error', message: err.message })
  })
}
