import { ipcMain } from 'electron'
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
}
