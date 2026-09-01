import { app, dialog, ipcMain, shell } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync } from 'fs'
import { IPC } from '../../shared/ipc-channels'
import { focusedWin } from './win'

/** Whatever belongs to the application rather than to a connection: files and folders. */

export function registerAppHandlers(): void {
  // --- Session logs ---
  ipcMain.handle(IPC.logsReveal, async () => {
    const dir = join(app.getPath('userData'), 'logs')
    // The directory only appears once a session with logging enabled has run.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
    return dir
  })


  // --- Dialogs ---
  /**
   * Picks a private key, starting where private keys actually live.
   *
   * Both halves matter and both were missing. Every SSH key is in a directory
   * whose name begins with a dot — `~/.ssh` for the ones people make, and
   * `~/.colima`, `~/.lima`, `~/.vagrant.d` for the ones tools make — and a
   * macOS open panel hides those by default. So the file being asked for was
   * invisible in the dialog asking for it, and the way through was a keyboard
   * shortcut nobody has a reason to know.
   */
  ipcMain.handle(IPC.dialogPickPrivateKey, async () => {
    const ssh = join(homedir(), '.ssh')
    const res = await dialog.showOpenDialog(focusedWin(), {
      properties: ['openFile', 'showHiddenFiles'],
      // Only when it exists: a defaultPath that does not opens the panel
      // somewhere arbitrary rather than at the home directory.
      defaultPath: existsSync(ssh) ? ssh : homedir(),
      title: 'Select private key'
    })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle(IPC.dialogPickSavePath, async (_e, defaultName: string) => {
    const res = await dialog.showSaveDialog(focusedWin(), { defaultPath: defaultName })
    return res.canceled ? undefined : res.filePath
  })
  ipcMain.handle(IPC.dialogPickOpenPath, async () => {
    const res = await dialog.showOpenDialog(focusedWin(), { properties: ['openFile'] })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle(IPC.dialogPickDirectory, async () => {
    const res = await dialog.showOpenDialog(focusedWin(), {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a destination folder'
    })
    return res.canceled ? undefined : res.filePaths[0]
  })
}
