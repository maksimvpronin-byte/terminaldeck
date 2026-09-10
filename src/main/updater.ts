import { BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'fs'
import { join } from 'path'
import { ADHOC_MARKER, canReplaceItself } from '../shared/adhocSigned'
import { IPC } from '../shared/ipc-channels'
import type { UpdateState } from '../shared/types'

/**
 * Where a build that cannot replace itself sends people instead. Written out
 * rather than read from anywhere: electron-builder's `publish` block is a build
 * file and is not shipped, and this is the one URL the running app needs.
 */
const RELEASES = 'https://github.com/maksimvpronin-byte/terminaldeck/releases/latest'

/**
 * Whether this build can replace itself, asked of the bundle it is running from.
 * The rule itself lives beside the marker it reads, where a test can reach it —
 * this module imports Electron and cannot be loaded outside it.
 */
function selfUpdating(): boolean {
  return canReplaceItself(process.platform, existsSync(join(process.resourcesPath, ADHOC_MARKER)))
}

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
    // The banner offers this only when the build can use it; a call that gets
    // here anyway would download a hundred megabytes to fail at the last step.
    if (!selfUpdating()) throw new Error('This build cannot install an update over itself')
    publish(win, { status: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  })

  // No argument: the renderer asks to be sent to the downloads, and the address
  // is this side's to know. Nothing on the page picks where the browser lands.
  ipcMain.handle(IPC.updateOpenPage, () => shell.openExternal(RELEASES))

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
    // A build that cannot replace itself still says a version is out; it just
    // offers the downloads rather than an install that cannot finish.
    if (selfUpdating()) publish(win, { status: 'available', version: info.version })
    else publish(win, { status: 'manual', version: info.version })
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
