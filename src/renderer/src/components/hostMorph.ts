import { collectLeaves, type LeafNode } from '../state/paneTree'
import type { WorkspaceTab } from '../state/slices/types'

/**
 * A host opening out of its row into a window, and folding back into it.
 *
 * Nothing real moves. A terminal counts its columns from the size of its pane
 * and a desktop asks the far end for a resolution whenever its pane changes, so
 * a pane that grew over a quarter of a second would be measured on every frame
 * of the way. What flies is a stand-in: a fixed element above everything, drawn
 * as a window with the host's name in its title bar, which starts as the row
 * and ends as the pane (or the other way round) and is then thrown away. The
 * pane itself is where it will be from the first frame, hidden under a fade
 * while the stand-in arrives.
 *
 * Every entry point does nothing where it cannot do it properly — no Web
 * Animations (the test DOM), somebody who asked their system for less motion,
 * a row scrolled out of sight or in a sidebar tab that is not showing — so a
 * caller never has to ask first.
 */

export interface MorphHost {
  /** The saved host, for finding its row. Absent for a quick connection. */
  sessionId?: string
  title: string
  colour?: string
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

const OPEN_MS = 260
const CLOSE_MS = 230
const FADE_MS = 150
/** Out of a row and into a pane: fast off the mark, settling at the end. */
const EASE_OPEN = 'cubic-bezier(0.2, 0, 0, 1)'
/** Into a row: gathering speed as it goes, the way a window is put away. */
const EASE_CLOSE = 'cubic-bezier(0.4, 0, 0.6, 1)'

/** The host a tab shows, as its row in the tree knows it. */
export function hostOfTab(tab: WorkspaceTab): MorphHost {
  return hostOfLeaf(collectLeaves(tab.root)[0], tab.title)
}

export function hostOfLeaf(leaf: LeafNode | undefined, fallbackTitle = ''): MorphHost {
  return {
    sessionId: leaf?.target.kind === 'session' ? leaf.target.sessionId : undefined,
    title: leaf?.title ?? fallbackTitle,
    colour: leaf?.color
  }
}

/**
 * The first of several boxes that can actually be seen inside another.
 *
 * A host sits under every group it belongs to, so its row can exist several
 * times over; and a row inside a collapsed-away scroll position is laid out but
 * not visible. Landing on either would fly the window somewhere nobody is
 * looking. A box counts when its middle is inside the viewport.
 */
export function firstVisible(boxes: Box[], viewport: Box): Box | undefined {
  return boxes.find((box) => {
    if (box.width <= 0 || box.height <= 0) return false
    const y = box.top + box.height / 2
    const x = box.left + Math.min(box.width, 40) / 2
    return (
      y >= viewport.top &&
      y <= viewport.top + viewport.height &&
      x >= viewport.left &&
      x <= viewport.left + viewport.width
    )
  })
}

function canAnimate(): boolean {
  if (typeof document === 'undefined' || typeof document.body.animate !== 'function') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function boxOf(el: Element | null | undefined): Box | undefined {
  if (!el) return undefined
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : undefined
}

/** Where a host's row is on screen right now, if it is showing anywhere. */
function rowOf(sessionId: string | undefined): Box | undefined {
  if (!sessionId) return undefined
  const rows = [...document.querySelectorAll(`[data-host-id="${CSS.escape(sessionId)}"]`)]
  for (const row of rows) {
    const viewport = boxOf(row.closest('.sidebar-tree'))
    const box = boxOf(row)
    if (box && viewport && firstVisible([box], viewport)) return box
  }
  return undefined
}

function ghost(host: MorphHost, at: Box): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'host-morph'
  if (host.colour) el.style.setProperty('--host-colour', host.colour)
  const bar = document.createElement('div')
  bar.className = 'host-morph-bar'
  bar.textContent = host.title
  el.appendChild(bar)
  place(el, at)
  document.body.appendChild(el)
  return el
}

function place(el: HTMLElement, box: Box): void {
  el.style.left = `${box.left}px`
  el.style.top = `${box.top}px`
  el.style.width = `${box.width}px`
  el.style.height = `${box.height}px`
}

const frame = (box: Box): Keyframe => ({
  left: `${box.left}px`,
  top: `${box.top}px`,
  width: `${box.width}px`,
  height: `${box.height}px`
})

/**
 * Opens a host out of the row that was double-clicked, into the tab that
 * connecting to it has just made current.
 *
 * Called straight after the tab is opened: the panel does not exist until React
 * has drawn it, so the flight is measured two frames later, by which time it
 * has been laid out at its real size.
 */
export function morphOpen(row: Element | null, tabId: string | undefined, host: MorphHost): void {
  if (!tabId || !canAnimate()) return
  const from = boxOf(row)
  if (!from) return
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>(
        `.tab-panel[data-tab-id="${CSS.escape(tabId)}"]`
      )
      const to = boxOf(panel)
      if (!panel || !to) return

      const el = ghost(host, to)
      el.animate([frame(from), frame(to)], { duration: OPEN_MS, easing: EASE_OPEN })
      // The pane is already there under the stand-in; it shows once the
      // stand-in has arrived rather than around its edges on the way.
      panel.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], {
        duration: OPEN_MS + FADE_MS
      })
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        delay: OPEN_MS,
        fill: 'forwards'
      }).onfinish = () => el.remove()
    })
  )
}

/**
 * Folds a closing window back into its host's row.
 *
 * Measured before the window goes, so call it first and close afterwards. With
 * no row to land on — a quick connection, a host in a sidebar tab that is not
 * showing, a row scrolled away — the window shrinks a little and fades where it
 * stood, which says "closed" without pointing somewhere untrue.
 */
export function morphClose(from: Element | null, host: MorphHost): void {
  if (!canAnimate()) return
  const start = boxOf(from)
  if (!start) return
  const row = rowOf(host.sessionId)
  const el = ghost(host, row ?? start)

  if (!row) {
    const shrunk: Box = {
      left: start.left + start.width * 0.04,
      top: start.top + start.height * 0.04,
      width: start.width * 0.92,
      height: start.height * 0.92
    }
    el.animate(
      [
        { ...frame(start), opacity: 1 },
        { ...frame(shrunk), opacity: 0 }
      ],
      {
        duration: CLOSE_MS,
        easing: EASE_CLOSE,
        fill: 'forwards'
      }
    ).onfinish = () => el.remove()
    return
  }

  // Landed: it lights the row for a moment and is gone, so the eye that
  // followed it ends up on the host it came from.
  el.animate([frame(start), frame(row)], { duration: CLOSE_MS, easing: EASE_CLOSE }).onfinish =
    () => el.classList.add('landing')
  el.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: FADE_MS * 2,
    delay: CLOSE_MS,
    fill: 'forwards'
  }).onfinish = () => el.remove()
}

/**
 * The element a tab is closed from: its window when that is the one showing,
 * otherwise its label in the strip — a background tab closed by its ✕ has no
 * window on screen to fold.
 */
export function tabElement(tabId: string): Element | null {
  const panel = document.querySelector(`.tab-panel[data-tab-id="${CSS.escape(tabId)}"]`)
  if (boxOf(panel)) return panel
  return document.querySelector(`.tab[data-tab-id="${CSS.escape(tabId)}"]`)
}
