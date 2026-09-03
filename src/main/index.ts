import { app, shell, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
import { desktopHoldsKeyboard, releaseKeyboard } from './keyboardCapture'
import { installCertificateVerifier } from './rdp/CertificateTrust'
import { freeRdpBridge } from './rdp/FreeRdpBridge'
import { remoteEdit } from './ssh/RemoteEdit'
import { remoteMonitor } from './ssh/RemoteMonitor'
import { shadowHostBridge } from './rdp/ShadowHostBridge'
import { registerUpdater } from './updater'
import { IPC } from '../shared/ipc-channels'

/**
 * The stock menu binds Cmd/Ctrl +, - and 0 to page zoom, and menu accelerators
 * fire before the renderer sees the key — which stole our terminal font-size
 * shortcuts. This template keeps everything else, including the Edit roles that
 * text fields rely on, and simply drops the zoom items.
 */
function buildApplicationMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * The keys that only ever say something is being held down.
 *
 * Never taken from a full-screen session: the combination is what carries the
 * meaning, and a session told about the `W` but not about the Ctrl in front of
 * it has been told the wrong thing.
 */
const HELD_MODIFIERS = new Set([
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock'
])

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // A window that has just loaded is holding no session, whatever the one
  // before it was doing. See releaseKeyboard.
  mainWindow.webContents.on('did-finish-load', releaseKeyboard)

  // Chromium zooms the page on Cmd/Ctrl with +, - or 0 on its own, quite apart
  // from the menu, and swallows the keys before the renderer sees them. Claiming
  // them here is the only place early enough; the renderer then resizes the
  // terminal font instead of scaling the whole interface.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return

    /**
     * A full-screen desktop owns the keyboard, and this is the only place that
     * can actually give it to one.
     *
     * The window can stop its own shortcuts and does, but a menu accelerator
     * never reaches the window at all — ⌘W is "Close Window" on a Mac, ⌘R
     * reloads, ⌘Q quits — and preventing the default here is documented to
     * stop the page events *and* the menu shortcuts. So the key is taken and
     * handed to the session over a channel of its own, which is the same trick
     * the zoom keys below have always needed.
     *
     * Two things are deliberately left alone. A modifier key itself goes
     * through untouched, or the far end would never learn that Ctrl is down
     * and every combination would arrive as a bare letter. And anything with
     * Alt held goes through too: those are not menu accelerators, and the
     * window turns Ctrl+Alt+End into the far side's Ctrl+Alt+Del — which it
     * cannot do for a key it never sees.
     */
    if (desktopHoldsKeyboard() && !input.alt && !HELD_MODIFIERS.has(input.code)) {
      event.preventDefault()
      // With the modifiers that were down, because this keystroke is one the
      // window will never see: it is how the session learns that its idea of
      // what is held still matches the keyboard.
      mainWindow.webContents.send(IPC.uiForwardKey, {
        code: input.code,
        control: input.control,
        shift: input.shift,
        alt: input.alt,
        meta: input.meta
      })
      return
    }

    const direction =
      input.key === '=' || input.key === '+'
        ? 'in'
        : input.key === '-' || input.key === '_'
          ? 'out'
          : input.key === '0'
            ? 'reset'
            : undefined
    if (!direction) return
    event.preventDefault()
    mainWindow.webContents.send(IPC.uiZoom, direction)
  })

  registerUpdater(mainWindow)

  /**
   * Nothing opens a window; a link is handed to the browser, and only a link.
   *
   * Nothing in this interface asks for one today — there are no anchors in the
   * renderer and the terminal does not turn output into links — so this is a
   * guard against a path that does not exist yet rather than one that does.
   * It is here because of what the missing check would cost if one appeared:
   * `openExternal` hands a URL to the operating system, and `file://` opens a
   * file with whatever is registered for it while `smb://` on Windows will
   * offer the user's credentials to whoever is listening. A hostile host that
   * ever managed to put a link on this screen would get a click's worth of
   * whatever the system does with it. Two schemes are all this application
   * needs.
   */
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const scheme = ((): string => {
      try {
        return new URL(details.url).protocol
      } catch {
        return ''
      }
    })()
    if (scheme === 'http:' || scheme === 'https:') shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.terminaldeck.app')
  buildApplicationMenu()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  // Answers the desktop code's question about a TLS certificate. Installed
  // rather than imported there: those modules are tested under plain Node,
  // where importing Electron fails at load time.
  installCertificateVerifier()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Nothing that draws a desktop outlives the application.
 *
 * The clients would exit on their own — their input pipe closes when this
 * process goes, and end of input is how they are told to stop — but only once
 * whatever they were doing came back to check. Saying it plainly first means a
 * quit is a quit rather than a race, and a session mid-frame does not hold the
 * far end open while it finishes.
 */
app.on('before-quit', () => {
  freeRdpBridge.stopAll()
  /**
   * The shadow viewers, which are the ones that matter here.
   *
   * Each is a `ShadowHost.exe` holding an mstsc window open, and it exits when
   * its input pipe closes — but only when it next looks, and a viewer waiting
   * on the far end may not look for a while. Both of these `stopAll` methods
   * existed for this and neither was called from anywhere: the monitors would
   * have died with the process, and the viewers might have outlived it.
   */
  shadowHostBridge.stopAll()
  remoteMonitor.stopAll()
  // The copies of remote files opened for editing. See RemoteEdit.cleanUp.
  remoteEdit.cleanUp()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
