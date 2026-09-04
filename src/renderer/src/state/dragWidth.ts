/**
 * Dragging an edge to resize something, and remembering where it was left.
 *
 * Written once and used by both the file panel and the host list. They want the
 * same behaviour and would otherwise have two of it — and the details that make
 * a drag feel right are exactly the ones a second implementation gets subtly
 * wrong: the cursor held on the body so it does not flicker when the pointer
 * leaves the grip, the listeners on the window so a fast drag is not lost the
 * moment the pointer overtakes the element, and the final value written once at
 * the end rather than on every frame.
 */

export function clampWidth(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, px))
}

export interface WidthDrag {
  /** Where the thing being dragged starts. */
  from: number
  /**
   * -1 for a grip on the left of what it sizes — that edge widens as the
   * pointer goes left — and 1 for a grip on the right.
   */
  sign: 1 | -1
  min: number
  max: number
  /** Called for every step, so the layout follows the pointer. */
  apply: (next: number) => void
  /** Called once, when the button comes up. */
  persist: (final: number) => void
}

export function startWidthDrag(
  down: { clientX: number; preventDefault(): void; stopPropagation(): void },
  drag: WidthDrag
): void {
  down.preventDefault()
  down.stopPropagation()

  const startX = down.clientX
  let latest = drag.from

  const onMove = (move: MouseEvent): void => {
    latest = clampWidth(drag.from + (move.clientX - startX) * drag.sign, drag.min, drag.max)
    drag.apply(latest)
  }
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    drag.persist(latest)
  }

  // Held on the body so the cursor does not flicker while the pointer is
  // dragged off the grip and over whatever is beside it.
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

/**
 * How wide the host list is, in pixels.
 *
 * Kept in this window's own storage rather than in the settings file: it is a
 * property of the screen somebody is sitting at, not of the configuration they
 * would carry to another machine — the same reasoning the file panel's width
 * already follows.
 */
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 640
export const SIDEBAR_DEFAULT = 260

const SIDEBAR_KEY = 'terminaldeck.sidebarWidth'

export function loadSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT
  return clampWidth(raw, SIDEBAR_MIN, SIDEBAR_MAX)
}

export function saveSidebarWidth(px: number): void {
  localStorage.setItem(SIDEBAR_KEY, String(Math.round(px)))
}
