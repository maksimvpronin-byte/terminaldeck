/**
 * The bar over a full-screen desktop: whether it stays or hides, and where
 * along the top edge it was left.
 *
 * Kept in this window's own storage rather than in the settings file, for the
 * reason the sidebar's width is: it is about the screen somebody is sitting at,
 * not the configuration they would carry to another machine.
 */

const PINNED_KEY = 'terminaldeck.fullscreenBar.pinned'
const AT_KEY = 'terminaldeck.fullscreenBar.at'

/** Pinned until somebody says otherwise, so the bar is there to be found the first time. */
export function loadBarPinned(): boolean {
  try {
    return localStorage.getItem(PINNED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveBarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(PINNED_KEY, String(pinned))
  } catch {
    // Not worth failing over: it is where the bar sits, nothing more.
  }
}

/** Where the bar's middle is, as a share of the width of the screen: 0.5 is the centre. */
export function loadBarAt(): number {
  try {
    const raw = localStorage.getItem(AT_KEY)
    const value = raw === null ? NaN : Number(raw)
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
  } catch {
    return 0.5
  }
}

export function saveBarAt(at: number): void {
  try {
    localStorage.setItem(AT_KEY, String(Math.round(at * 1000) / 1000))
  } catch {
    // As above.
  }
}

/**
 * The left edge of a bar `barWidth` wide whose middle is meant to be at `at`
 * of a screen `screenWidth` wide — kept whole on the screen however near an
 * edge it was dragged, and on a narrower display than the one it was left on.
 */
export function barLeft(at: number, barWidth: number, screenWidth: number): number {
  const room = Math.max(0, screenWidth - barWidth)
  return Math.round(Math.min(room, Math.max(0, at * screenWidth - barWidth / 2)))
}
