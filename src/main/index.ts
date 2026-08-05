import { app, shell, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/handlers'
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

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
