/**
 * A terminal selection that lasts only as long as the clipboard holds it.
 *
 * MobaXterm does this: select, and it is copied; copy something else, here or
 * in any other program, and the selection goes. What is highlighted is then
 * always what a paste would bring in. Here it is a setting, off by default,
 * and it means something only with copying on selection — see
 * `clearSelectionOnClipboardChange`.
 *
 * Nothing tells a window that the clipboard changed, so it is looked at:
 *
 * - when a terminal copies, which also takes away the selection of whichever
 *   terminal copied before it — the clipboard holds one thing;
 * - when the window comes back to the front, which is how a copy made in
 *   another program shows up;
 * - every half second while the window is in front and a selection is held,
 *   for a copy that lands without the window losing focus: a remote desktop
 *   in a pane, a host's address copied from the tree, a clipboard manager.
 *   Nothing is read while no selection is held.
 */
import { useStore } from './state/store'

/** Whoever holds the selection, and how to take it away. */
export interface SelectionOwner {
  clear(): void
}

export interface SelectionWatchDeps {
  /** The clipboard's text, or '' when it holds none. */
  read(): string
  /** The setting, and copying on selection, are both on. */
  enabled(): boolean
  /** The window is in front; while it is not, the next focus does the looking. */
  focused(): boolean
  /** Where the window's `focus` comes from. */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  intervalMs?: number
}

export interface SelectionWatch {
  /** `owner` put `text` on the clipboard from its selection. */
  copied(owner: SelectionOwner, text: string): void
  /** `owner`'s selection went by itself — a click, a clear, a new screen. */
  released(owner: SelectionOwner): void
  /** Looks at the clipboard now. */
  check(): void
  dispose(): void
}

const INTERVAL_MS = 500

let shared: SelectionWatch | undefined

/** The window's one watch, for every terminal in it. */
export function selectionWatch(): SelectionWatch {
  shared ??= createSelectionWatch({
    read: () => window.td.clipboard.read(),
    enabled: () => {
      const { copyOnSelect, clearSelectionOnClipboardChange } = useStore.getState().settings
      return copyOnSelect && clearSelectionOnClipboardChange
    },
    focused: () => document.hasFocus(),
    target: window
  })
  return shared
}

/**
 * The same text, whichever line endings it came back with. A program that
 * copies the very lines selected here may well write them with CR LF.
 */
function sameText(a: string, b: string): boolean {
  return a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
}

export function createSelectionWatch(deps: SelectionWatchDeps): SelectionWatch {
  let held: { owner: SelectionOwner; text: string } | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  function stop(): void {
    clearInterval(timer)
    timer = undefined
  }

  function drop(): void {
    held = null
    stop()
  }

  function check(): void {
    if (!held) return stop()
    if (!deps.enabled()) return drop()
    if (!deps.focused()) return
    if (sameText(deps.read(), held.text)) return
    const { owner } = held
    drop()
    owner.clear()
  }

  const onFocus = (): void => check()
  deps.target.addEventListener('focus', onFocus)

  return {
    copied(owner, text) {
      if (!deps.enabled()) return drop()
      const before = held?.owner
      held = { owner, text }
      if (before && before !== owner) before.clear()
      if (!timer) timer = setInterval(check, deps.intervalMs ?? INTERVAL_MS)
    },
    released(owner) {
      if (held?.owner === owner) drop()
    },
    check,
    dispose() {
      drop()
      deps.target.removeEventListener('focus', onFocus)
    }
  }
}
