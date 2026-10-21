/**
 * xterm's scrollbar left behind the screen it scrolls.
 *
 * xterm keeps two positions: the row the screen shows, and the scrollTop of a
 * plain scrolling element whose bar is the one on the right. Output moves the
 * first and sets the second to match. A terminal in a hidden tab has no layout,
 * so the browser drops that second step — and when the tab is shown again it
 * puts back the scrollTop the element had when it was hidden. The screen is at
 * the end of what `cat` printed; the bar is still where the prompt was before
 * it. The next turn of the wheel scrolls from the bar's place, not the
 * screen's, so the view leaps back up to the command and seems stuck there.
 * The bar's length is wrong too: xterm measured the history against a window
 * of no height, a screen short, so even a bar put at its end scrolls up a
 * screen at once. A tab shown again has xterm measure both afresh.
 *
 * This check is the second line, for a bar left behind any other way. Only
 * the end of the history is checked. That is where output leaves the
 * screen, and it is the one place the right scrollTop is known without
 * xterm's own row height: as far down as the element goes.
 */
export interface ScrollState {
  /** The screen shows the newest rows, as it does unless scrolled back. */
  atBottom: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  /** One row, in the same pixels; the gap allowed before calling it behind. */
  rowHeight: number
}

/**
 * The scrollbar is short of the end while the screen is at it.
 *
 * Within half a row is not behind: at a fractional display scale xterm's own
 * scrollTop and the browser's rounded heights disagree by a pixel or so.
 */
export function scrollbarBehind(state: ScrollState): boolean {
  if (!state.atBottom) return false
  const gap = state.scrollHeight - state.clientHeight - state.scrollTop
  return gap > Math.max(state.rowHeight / 2, 1)
}
