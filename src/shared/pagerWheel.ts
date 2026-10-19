/**
 * The mouse wheel in a pager that does not take the alternate screen.
 *
 * xterm turns the wheel into arrow keys only on the alternate screen, which is
 * where vim, tmux and an ordinary `less` draw. journalctl starts `less` with
 * `-X` (its default `LESS` is `FRSXMK`), and `-X` keeps it on the normal
 * screen, so the wheel scrolled the terminal's own history instead: back up
 * over the shell prompt and the command, while the pager sat where it was.
 *
 * Nothing in the stream says a pager is running, so this goes by what one
 * leaves on screen: its prompt — `:`, or `lines 1-47`, `(END)` and the like in
 * reverse video — on the bottom row, with the cursor right after it. A shell's
 * prompt is not drawn in reverse video and is not a bare colon.
 */

export interface PagerScreen {
  /** Which of xterm's two buffers is showing. */
  buffer: 'normal' | 'alternate'
  /** The view is up in the history rather than at the live screen. */
  scrolledBack: boolean
  /** The cursor is on the bottom row of the screen. */
  cursorOnLastRow: boolean
  /** The text of the cursor's row, trailing blanks dropped. */
  cursorLine: string
  /** The first cell of the cursor's row is in reverse video. */
  cursorLineStartsInverse: boolean
}

/** Whether the wheel should go to the program as arrow keys. */
export function wheelGoesToPager(screen: PagerScreen): boolean {
  // The alternate screen is xterm's to handle, and already is.
  if (screen.buffer !== 'normal') return false
  // Someone reading the history keeps scrolling it.
  if (screen.scrolledBack) return false
  if (!screen.cursorOnLastRow) return false
  const line = screen.cursorLine.trim()
  if (line === '') return false
  return line === ':' || screen.cursorLineStartsInverse
}

/** The arrow keys a wheel turn of `lines` sends, down for a positive count. */
export function wheelArrows(lines: number, applicationCursorKeys: boolean): string {
  const key = `\x1b${applicationCursorKeys ? 'O' : '['}${lines < 0 ? 'A' : 'B'}`
  return key.repeat(Math.abs(lines))
}

/**
 * How many rows a wheel event is worth, and what is left over.
 *
 * A trackpad sends many small pixel deltas; the part of a row each leaves is
 * carried to the next, or a slow swipe would never move a line at all.
 */
export function wheelRows(
  deltaY: number,
  deltaMode: number,
  rowHeight: number,
  carry: number
): { rows: number; carry: number } {
  let amount: number
  if (deltaMode === 1) amount = deltaY
  else if (deltaMode === 2) amount = deltaY * 10
  else amount = rowHeight > 0 ? deltaY / rowHeight : 0
  amount += carry
  const rows = Math.trunc(amount)
  return { rows, carry: amount - rows }
}
