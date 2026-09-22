import { BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { existsSync } from 'fs'
import { join } from 'path'
import { ADHOC_MARKER, canReplaceItself } from '../shared/adhocSigned'
import { IPC } from '../shared/ipc-channels'
import { stateForRelease } from '../shared/updateState'
import type { UpdateState } from '../shared/types'

/**
 * Where a build that cannot replace itself sends people instead. Written out
 * rather than read from anywhere: electron-builder's `publish` block is a build
 * file and is not shipped, and this is the one URL the running app needs.
 */
const RELEASES = 'https://github.com/maksimvpronin-byte/terminaldeck/releases/latest'

/**
 * How often a running application asks again.
 *
 * It asked once, at startup, and that is not often enough for anything: a copy
 * left open across a release never hears about it, which on a machine somebody
 * does not reboot means never. An hour is frequent enough that a release
 * reaches people the day it is published and rare enough to be invisible — one
 * HTTPS request for a few hundred bytes of YAML.
 */
const RECHECK_MS = 60 * 60 * 1000

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
/**
 * The window to tell, which is whichever window is newest.
 *
 * The handlers are bound once, and they used to close over the window they were
 * bound with. On a Mac, closing that window and opening the app again from the
 * Dock makes a new one — and every later word about an update went to the
 * destroyed first window and was dropped, so a downloaded update never offered
 * to install.
 */
let current: BrowserWindow | undefined

function publish(next: UpdateState): void {
  state = next
  if (current && !current.isDestroyed()) current.webContents.send(IPC.updateState, next)
}

export function registerUpdater(win: BrowserWindow): void {
  current = win
  if (registered) return
  registered = true

  ipcMain.handle(IPC.updateGetState, () => state)

  ipcMain.handle(IPC.updateDownload, async () => {
    // The banner offers this only when the build can use it; a call that gets
    // here anyway would download a hundred megabytes to fail at the last step.
    if (!selfUpdating()) throw new Error('This build cannot install an update over itself')
    publish({ status: 'downloading', percent: 0 })
    await autoUpdater.downloadUpdate()
  })

  // No argument: the renderer asks to be sent to the downloads, and the address
  // is this side's to know. Nothing on the page picks where the browser lands.
  ipcMain.handle(IPC.updateOpenPage, () => shell.openExternal(RELEASES))

  /**
   * Asked for by hand, and answering with the version found rather than with
   * nothing.
   *
   * The events say what to *do* about an update; this says what was seen, so a
   * settings screen can tell "checked, nothing newer" from "checked, and the
   * banner above is about it". Without it a manual check is a button that
   * appears to do nothing whenever the answer is good news.
   */
  ipcMain.handle(IPC.updateCheck, async () => {
    if (is.dev) return null
    const found = await autoUpdater.checkForUpdates()
    return found?.updateInfo?.version ?? null
  })

  ipcMain.handle(IPC.updateInstall, () => {
    // Quits the app and relaunches into the new version. Silent, because the
    // installer is not one-click: run visibly it walks through its whole wizard
    // again — folder, options, Finish — for what is an update, not an install.
    // Silently it reuses the folder it was installed to, and the second flag
    // starts the app again once it is done.
    autoUpdater.quitAndInstall(true, true)
  })

  // In dev there is no packaged app to replace, and electron-updater throws.
  if (is.dev) return

  // Downloads are explicit: an SSH client should not restart itself mid-session.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    // A build that cannot replace itself still says a version is out; it just
    // offers the downloads rather than an install that cannot finish. And a
    // release already being fetched, or fetched, stays where it has got to.
    const next = stateForRelease(state, info.version, selfUpdating())
    if (next !== state) publish(next)
  })
  autoUpdater.on('update-not-available', () => {
    if (state.status !== 'ready') publish({ status: 'idle' })
  })
  autoUpdater.on('download-progress', (p) => {
    publish({ status: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    publish({ status: 'ready', version: info.version })
  })
  /*
   * A check that fails says nothing about an update already downloaded: it is
   * on disk, and installing it needs no network. Reported over it, the error
   * took away the only button that installs it.
   */
  const failed = (err: Error): void => {
    if (state.status !== 'ready') publish({ status: 'error', message: err.message })
  }
  autoUpdater.on('error', failed)

  const ask = (): void => {
    autoUpdater.checkForUpdates().catch(failed)
  }

  ask()
  /*
   * And again, on the hour, unless there is already an answer to act on.
   * Re-announcing an update somebody has seen and left for later is noise, and
   * asking while one is downloading would interrupt it.
   */
  const timer = setInterval(() => {
    if (state.status === 'idle' || state.status === 'error') ask()
  }, RECHECK_MS)
  timer.unref?.()
}
