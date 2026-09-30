import { app, type BrowserWindow } from 'electron'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { diag } from './diagnostics'
import { macKeyboard, type MacKeyboard } from './macKeyboard'
import { desktopHoldsKeyboard, onKeyboardCapture } from './keyboardCapture'

/**
 * ⌘Tab, handed to a full-screen desktop as the far side's Alt+Tab.
 *
 * ⌘Tab is answered by the window server before any application sees it, so a
 * desktop could never have it however the keyboard was claimed — the page hears
 * ⌘ go down, and next that the window lost focus. The native switch in
 * `resources/hotkeys` turns macOS's ⌘Tab and ⌘⇧Tab off and nothing else, so
 * the screenshot keys, fn and Spotlight stay the system's; this decides when.
 *
 * Only while all three hold: a desktop has the keyboard, the window is full
 * screen, and it is the window in front. That is the one arrangement in which
 * the keys belong to the far machine by choice. Any of them ending gives ⌘Tab
 * back — a click outside the desktop, leaving full screen, or a three-finger
 * swipe to another space, which is a gesture and was never taken.
 *
 * What the switch sets belongs to the login session, not to this process: an
 * application that crashes with ⌘Tab taken leaves it taken, for every
 * application, until something gives it back. So a mark is left on disk for as
 * long as it is taken, and the next start that finds one gives it back first.
 */

/** The half of `td_hotkeys.node` this uses; see `macKeyboard`. */
export type HotkeySwitch = Pick<MacKeyboard, 'setEnabled'>

/** Whether this application has ⌘Tab taken, kept where a crash cannot lose it. */
export interface TakenMark {
  exists(): boolean
  set(taken: boolean): void
}

export interface HotkeyState {
  desktopHoldsKeyboard: boolean
  fullScreen: boolean
  focused: boolean
}

/**
 * The deciding half, with nothing of Electron in it.
 *
 * Tells the switch only when the answer changes, and remembers a refusal as no
 * change at all, so the next event tries again rather than believing it worked.
 */
export function hotkeyGate(
  native: HotkeySwitch,
  mark: TakenMark,
  log: (message: string) => void = () => undefined
): { update(state: HotkeyState): void; restore(): void } {
  let off = false

  // Left by a run that ended with ⌘Tab still taken.
  if (mark.exists()) {
    if (native.setEnabled(true)) mark.set(false)
    log('⌘Tab given back to macOS, left taken by a run that ended without doing it')
  }

  function set(enabled: boolean): void {
    if (off === !enabled) return
    // Marked before it is taken, so there is no moment it is taken unmarked.
    if (!enabled) mark.set(true)
    if (native.setEnabled(enabled)) {
      off = !enabled
      if (enabled) mark.set(false)
      log(enabled ? '⌘Tab back with macOS' : '⌘Tab goes to the desktop')
    } else {
      if (!enabled) mark.set(false)
      log(`the window server refused to turn ⌘Tab ${enabled ? 'on' : 'off'}`)
    }
  }

  return {
    update: (state) => set(!(state.desktopHoldsKeyboard && state.fullScreen && state.focused)),
    restore: () => set(true)
  }
}

export function registerSystemHotkeys(win: BrowserWindow): void {
  const native = macKeyboard()
  if (!native) return
  if (!native.available()) {
    diag('keys', 'this macOS has no switch for ⌘Tab; it stays with the system')
    return
  }
  const file = join(app.getPath('userData'), 'command-tab-taken')
  const mark: TakenMark = {
    exists: () => existsSync(file),
    set: (taken) => {
      try {
        if (taken) writeFileSync(file, '')
        else rmSync(file, { force: true })
      } catch (err) {
        diag(
          'keys',
          `the ⌘Tab mark could not be ${taken ? 'left' : 'cleared'}: ${(err as Error).message}`
        )
      }
    }
  }
  const gate = hotkeyGate(native, mark, (message) => diag('keys', message))

  const update = (): void => {
    if (win.isDestroyed()) return gate.restore()
    gate.update({
      desktopHoldsKeyboard: desktopHoldsKeyboard(),
      fullScreen: win.isFullScreen(),
      focused: win.isFocused()
    })
  }

  onKeyboardCapture(update)
  win.on('focus', update)
  win.on('blur', update)
  win.on('enter-full-screen', update)
  win.on('leave-full-screen', update)
  win.on('enter-html-full-screen', update)
  win.on('leave-html-full-screen', update)
  win.on('minimize', update)
  win.on('hide', update)
  win.on('closed', () => gate.restore())
  // Before anything else is torn down: nothing undoes it for a process that
  // has gone, which is what the mark above is for.
  app.on('will-quit', () => gate.restore())
}
