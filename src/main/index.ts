import { app, shell, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
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

  // Chromium zooms the page on Cmd/Ctrl with +, - or 0 on its own, quite apart
  // from the menu, and swallows the keys before the renderer sees them. Claiming
  // them here is the only place early enough; the renderer then resizes the
  // terminal font instead of scaling the whole interface.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return
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

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
