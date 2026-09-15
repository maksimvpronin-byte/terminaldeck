import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../shared/ipc-channels'

/**
 * Whether a desktop session is currently full screen and owning the keyboard.
 *
 * The window decides this — it is the only side that knows which pane is full
 * screen — but the main process needs the answer, because two kinds of key
 * never reach the window at all. Chromium zooms the whole interface on Ctrl
 * with `+`, `-` or `0`; and a menu accelerator, ⌘W for Close Window among them,
 * is answered before the page is told anything. Both are settled in
 * `before-input-event`, which is why a session that should be receiving every
 * key cannot simply be left to it.
 *
 * A single flag rather than one per window: there is one window, and a second
 * one would need this rewritten around its id rather than extended.
 */
let held = false

export function desktopHoldsKeyboard(): boolean {
  return held
}

/**
 * Forgets the claim, for a window that has started again.
 *
 * A renderer that reloaded or came back from a crash is holding nothing, and a
 * flag left over from the session it had would go on taking every combination
 * and sending it somewhere that no longer exists — with no way to type the
 * shortcut that would fix it.
 */
export function releaseKeyboard(): void {
  held = false
}

export function registerKeyboardCapture(): void {
  ipcMain.on(IPC.uiKeyboardCapture, (_e, capture: boolean) => {
    held = capture === true
  })

  /**
   * The keyboard, given back to a window a `confirm()` took it from.
   *
   * On Windows, once the page's own dialog closes, the window is in front and
   * clicks still land, but nothing in it can take focus again: an input shows
   * no caret and swallows every keystroke — the host filter was where it was
   * noticed — until the window loses and regains focus, which is why
   * minimising and restoring it "fixed" it. `webContents.focus()` does not
   * undo it; taking the focus away and giving it back does, and it does so
   * even for a window already in that state. A dialog raised by this process
   * (`dialog.showMessageBox`) does not cause it.
   *
   * Only there: elsewhere the dialog does not break anything, and blurring a
   * macOS window deactivates the application for a moment.
   */
  ipcMain.on(IPC.uiRefocus, (event) => {
    if (process.platform !== 'win32') return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    win.blur()
    win.focus()
  })
}
