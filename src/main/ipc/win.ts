import { BrowserWindow } from 'electron'

/**
 * The window an IPC call is answered into.
 *
 * Every handler that raises a dialog or sends something back needs one, and the
 * answer is the same in all of them: the focused window, or the only one there
 * is. Its own module because nearly every group of handlers wants it.
 */

export function focusedWin(): BrowserWindow {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) throw new Error('No window available')
  return win
}
