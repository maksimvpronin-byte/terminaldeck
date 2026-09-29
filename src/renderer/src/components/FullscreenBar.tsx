import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../i18n'
import { barLeft, loadBarAt, loadBarPinned, saveBarAt, saveBarPinned } from '../state/fullscreenBar'
import { toggleFullscreen } from './RemoteScreen'
import { CloseIcon, LeaveFullscreenIcon, MinimizeIcon, PinIcon } from './icons'

/** How near the top edge the pointer has to come to call a hidden bar back, in pixels. */
const EDGE = 2
/** How far either side of the bar that edge counts, so it need not be hit exactly. */
const REACH = 24

/**
 * The bar over a full-screen desktop, after the one a Remote Desktop client
 * keeps there: the session's name, a pin, minimise, leave full screen, close.
 *
 * It is small and it sits in the middle of the top edge, not across it — the
 * far side keeps its own tab strip, menu bar and window buttons along that edge
 * — and it can be dragged along the edge out of the way of whatever is under
 * it. Dropped on another display, the window follows it there.
 *
 * Unpinned, it slides away and comes back only for a pointer pushed against
 * the top edge where the bar is.
 *
 * There is not one `title` anywhere on it. A `title` is a native tooltip, a
 * window of the operating system above everything on the screen, and one that
 * was up when the pane toolbar slid away used to stay behind at the top of the
 * display taking clicks — which is what ended that toolbar in full screen. The
 * labels here are drawn by the page, and go when the bar does.
 *
 * Nothing on it takes the focus either. The session holds the keyboard in full
 * screen, and a click on the pin moving it onto a button would leave every key
 * after it going nowhere.
 */
export default function FullscreenBar({
  paneId,
  title,
  pane,
  onClose
}: {
  paneId: string
  title: string
  /** The element that is full screen; its width is the screen's. */
  pane: HTMLElement
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const barRef = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(loadBarPinned)
  const [at, setAt] = useState(loadBarAt)
  const atRef = useRef(at)
  atRef.current = at
  const [left, setLeft] = useState(0)
  /** Only asked when unpinned: a pinned bar is always out. */
  const [shown, setShown] = useState(true)
  const hovered = useRef(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const drag = useRef<{ x: number; at: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Being dragged off this display, to be let go of on another. */
  const [away, setAway] = useState(false)

  const cancelHide = useCallback((): void => {
    window.clearTimeout(hideTimer.current)
  }, [])
  const hideSoon = useCallback((delay: number): void => {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      if (!hovered.current && !drag.current) setShown(false)
    }, delay)
  }, [])
  useEffect(() => cancelHide, [cancelHide])

  /* Where it sits, kept whole on the screen whatever the screen's width. */
  useLayoutEffect(() => {
    const place = (): void => {
      const bar = barRef.current
      if (bar) setLeft(barLeft(at, bar.offsetWidth, pane.clientWidth))
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [at, title, away, pane])

  /*
   * Unpinned: out long enough on arriving to be seen and found again, then
   * away. A pointer already on it — the pin was just clicked — keeps it out
   * until it leaves.
   */
  useEffect(() => {
    if (pinned) {
      cancelHide()
      setShown(true)
      return
    }
    if (!hovered.current) hideSoon(1500)
  }, [pinned, cancelHide, hideSoon])

  /*
   * Called back by the pointer at the top edge, over where the bar is.
   *
   * Listened for on the pane, in the capture phase, so the desktop under the
   * pointer still gets every movement — nothing is laid over the edge to catch
   * the pointer, and so nothing there swallows a click meant for the far side.
   */
  useEffect(() => {
    if (pinned) return
    const onMove = (event: PointerEvent): void => {
      if (event.clientY > EDGE) return
      const bar = barRef.current
      if (!bar) return
      const box = bar.getBoundingClientRect()
      if (event.clientX < box.left - REACH || event.clientX > box.right + REACH) return
      setShown(true)
      if (!hovered.current) hideSoon(1200)
    }
    pane.addEventListener('pointermove', onMove, { capture: true, passive: true })
    return () => pane.removeEventListener('pointermove', onMove, { capture: true })
  }, [pinned, pane, hideSoon])

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    saveBarPinned(next)
  }

  /* ------------------------------------------------------------- dragging */

  const offScreen = (event: ReactPointerEvent): boolean =>
    event.clientX < 0 ||
    event.clientY < 0 ||
    event.clientX >= window.innerWidth ||
    event.clientY >= window.innerHeight

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return
    // No focus taken, no text selected on the way along.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, at: atRef.current }
    setDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    const bar = barRef.current
    if (!start || !bar) return
    const width = pane.clientWidth
    // Stopped where the bar meets the edge, so dragging back from past it moves
    // the bar at once rather than first winding back through a share of the
    // screen it could never stand on.
    const half = bar.offsetWidth / 2 / width
    const next = start.at + (event.clientX - start.x) / width
    setAt(Math.min(1 - half, Math.max(half, next)))
    setAway(offScreen(event))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, move: boolean): void => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    setAway(false)
    saveBarAt(atRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (move && offScreen(event)) void window.td.ui.moveFullscreen(paneId)
  }

  /** A button that does its work on click and leaves the focus where it was. */
  const button = (
    label: string,
    onClick: () => void,
    icon: JSX.Element,
    extra = ''
  ): JSX.Element => (
    <button
      type="button"
      className={`fullscreen-bar-button ${extra}`}
      aria-label={label}
      data-tip={label}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon}
    </button>
  )

  const out = pinned || shown || dragging
  return (
    <div
      ref={barRef}
      className={`fullscreen-bar ${out ? '' : 'tucked'} ${dragging ? 'dragging' : ''} ${away ? 'away' : ''}`}
      style={{ left }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onMouseEnter={() => {
        hovered.current = true
        cancelHide()
      }}
      onMouseLeave={() => {
        hovered.current = false
        if (!pinned) hideSoon(600)
      }}
    >
      {button(
        pinned
          ? t('Unpin: hide until the pointer reaches the top edge')
          : t('Pin: keep the bar on screen'),
        togglePin,
        <PinIcon pinned={pinned} />,
        pinned ? 'active' : ''
      )}
      <span className="fullscreen-bar-title">
        {away ? t('Let go to move to that display') : title}
      </span>
      {button(t('Minimize'), () => void window.td.ui.minimizeFullscreen(paneId), <MinimizeIcon />)}
      {button(t('Leave full screen (F11)'), () => toggleFullscreen(pane), <LeaveFullscreenIcon />)}
      {button(t('Close this session'), onClose, <CloseIcon />, 'danger')}
    </div>
  )
}
