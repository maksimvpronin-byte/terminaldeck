import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { refuse } from './ipc/guard'
import { placeOn } from '../shared/windowPlacement'

/**
 * What the bar over a full-screen desktop asks of the window.
 *
 * Both of these are things the page cannot do by itself. A window cannot be
 * minimised from inside it, and it cannot be moved to another display — and
 * neither can be done while it is full screen at all: macOS refuses to
 * miniaturise a full-screen window, and a full-screen window is pinned to the
 * display it went full screen on. So both leave full screen first, do their
 * part, and put the same pane back full screen afterwards.
 *
 * Putting it back is the part the page could not do on its own either.
 * `requestFullscreen` is honoured only in answer to a click, and by the time the
 * window has left full screen and moved, the click that asked for it is long
 * spent. `executeJavaScript` with `userGesture` is Electron's own way round
 * that, and the only one it has.
 */

/** Pane ids are nanoids; anything else is not one of ours. */
const PANE_ID = /^[\w-]{1,64}$/

function paneIdOf(value: unknown): string {
  if (typeof value !== 'string' || !PANE_ID.test(value)) refuse('a pane id')
  return value
}

/** Waits for the window to report leaving full screen, or gives up waiting. */
function leftFullScreen(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    // macOS animates the way out; Windows does not, and says so at once. The
    // timeout is for a window that never says anything, so nothing hangs on it.
    const timer = setTimeout(done, 2000)
    win.once('leave-full-screen', done)
    function done(): void {
      clearTimeout(timer)
      win.removeListener('leave-full-screen', done)
      resolve()
    }
  })
}

/**
 * Out of full screen, both the pane's and the window's.
 *
 * They are two things. The pane going full screen takes the window with it, and
 * normally brings it back as well — but a window that was already full screen
 * from the menu before the pane was stays so when the pane lets go.
 */
async function leaveFullScreen(win: BrowserWindow): Promise<void> {
  const waiting = win.isFullScreen() ? leftFullScreen(win) : null
  await win.webContents
    .executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : null', true)
    .catch(() => undefined)
  if (waiting) await waiting
  if (win.isFullScreen()) {
    const again = leftFullScreen(win)
    win.setFullScreen(false)
    await again
  }
}

/** The pane put back full screen, as if the button on its toolbar had been clicked. */
function enterPaneFullScreen(win: BrowserWindow, paneId: string): Promise<boolean> {
  if (win.isDestroyed()) return Promise.resolve(false)
  // The id has been checked against PANE_ID, and goes in as a JSON string besides.
  const script = `(() => {
    const pane = [...document.querySelectorAll('.pane')].find((el) => el.dataset.paneId === ${JSON.stringify(paneId)})
    return pane ? pane.requestFullscreen().then(() => true, () => false) : false
  })()`
  return win.webContents.executeJavaScript(script, true).then(
    (entered: unknown) => entered === true,
    () => false
  )
}

/**
 * The pane to put back full screen when the window comes back from the Dock or
 * the taskbar. One per window, so minimising twice does not queue two panes up
 * to fight over the screen.
 */
const restoreTo = new WeakMap<BrowserWindow, string>()

export function registerFullscreenWindow(): void {
  ipcMain.handle(IPC.uiMinimizeFullscreen, async (event, rawPaneId: unknown) => {
    const paneId = paneIdOf(rawPaneId)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    await leaveFullScreen(win)
    if (!restoreTo.has(win)) {
      win.once('restore', () => {
        const pane = restoreTo.get(win)
        restoreTo.delete(win)
        if (pane) void enterPaneFullScreen(win, pane)
      })
    }
    restoreTo.set(win, paneId)
    win.minimize()
  })

  /**
   * To whichever display the pointer is over now.
   *
   * Asked of the system rather than taken from the page's own coordinates:
   * where a pointer is on a desktop of several displays at several scales is a
   * question Chromium answers in its own units, and the answer that places a
   * window is the one in the system's.
   *
   * Nothing happens if that is the display the window is already on, which is
   * also what a bar dropped just past the edge of the only display comes to.
   */
  ipcMain.handle(IPC.uiMoveFullscreen, async (event, rawPaneId: unknown): Promise<boolean> => {
    const paneId = paneIdOf(rawPaneId)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (target.id === screen.getDisplayMatching(win.getBounds()).id) return false

    await leaveFullScreen(win)
    if (win.isDestroyed()) return false
    if (win.isMaximized()) win.unmaximize()
    win.setBounds(placeOn(win.getBounds(), target.workArea))
    return enterPaneFullScreen(win, paneId)
  })
}
