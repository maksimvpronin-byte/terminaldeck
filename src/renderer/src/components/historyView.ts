import { Terminal } from '@xterm/xterm'
import { replayLines } from './screenReplay'

/**
 * What was in the terminal before vi, read with vi still open.
 *
 * A full-screen program draws on the alternate screen, which has no history
 * of its own, and xterm shows one screen or the other — so scrolling up in vi
 * used to reach nothing. This lays a second, read-only terminal over the pane
 * holding the history and, under it, the program's screen as it stands: it
 * opens on that screen, so to the eye the program's screen slides down and the
 * history comes in above it. Scrolling back past the bottom, or any key,
 * takes it away again; the program underneath was never touched.
 */
export interface HistoryView {
  close(): void
  /** Takes the selection away, as something else copied does: see selectionWatch.ts. */
  clearSelection(): void
}

export interface HistoryViewOptions {
  /** How far the wheel turn that opened it had already scrolled, in rows. */
  scrolled: number
  hint: string
  onCopy: (text: string) => void
  onClose: () => void
}

export function openHistoryView(
  term: Terminal,
  host: HTMLElement,
  options: HistoryViewOptions
): HistoryView {
  const normal = term.buffer.normal
  const screen = term.buffer.alternate
  // Up to the cursor: the screen below it was blank when the program started.
  const history = normal.baseY + normal.cursorY + 1
  const content =
    '\x1b[?25l' + replayLines(normal, 0, history) + '\r\n' + replayLines(screen, 0, screen.length)

  const el = document.createElement('div')
  el.className = 'terminal-history'
  el.style.top = `${host.offsetTop}px`
  el.style.left = `${host.offsetLeft}px`
  el.style.width = `${host.offsetWidth}px`
  el.style.height = `${host.offsetHeight}px`
  el.style.background = term.options.theme?.background ?? ''
  const hint = document.createElement('div')
  hint.className = 'terminal-history-hint'
  hint.textContent = options.hint
  host.parentElement?.append(el)

  const view = new Terminal({
    cols: term.cols,
    rows: term.rows,
    scrollback: history + screen.length,
    fontFamily: term.options.fontFamily,
    fontSize: term.options.fontSize,
    lineHeight: term.options.lineHeight,
    letterSpacing: term.options.letterSpacing,
    theme: term.options.theme,
    minimumContrastRatio: term.options.minimumContrastRatio,
    disableStdin: true,
    cursorBlink: false
  })
  view.open(el)
  el.append(hint)

  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    left.dispose()
    view.dispose()
    el.remove()
    options.onClose()
    term.focus()
  }

  view.write(content, () => {
    if (closed) return
    view.scrollToBottom()
    view.scrollLines(options.scrolled)
    view.focus()
  })

  view.attachCustomWheelEventHandler((e) => {
    const buffer = view.buffer.active
    if (e.deltaY > 0 && buffer.viewportY >= buffer.baseY) {
      e.preventDefault()
      close()
      return false
    }
    return true
  })

  view.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return false
    // A modifier on its own is the start of a copy, not a way out.
    if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return false
    const copy =
      e.key.toLowerCase() === 'c' && (e.metaKey || (e.ctrlKey && e.shiftKey)) && view.hasSelection()
    if (copy) options.onCopy(view.getSelection())
    else close()
    return false
  })

  // The program left the alternate screen: what this shows is gone.
  const left = term.buffer.onBufferChange((buffer) => {
    if (buffer.type === 'normal') close()
  })

  return { close, clearSelection: () => view.clearSelection() }
}
