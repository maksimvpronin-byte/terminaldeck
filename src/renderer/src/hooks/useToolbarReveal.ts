import { useEffect, useState, type RefObject } from 'react'

/** How long the pointer must stay at the edge before the toolbar comes back. */
const EDGE_DWELL = 500
/** How close to the top counts as the edge, in CSS pixels. */
const EDGE = 2

/**
 * Whether the pane's toolbar should be showing over a full-screen session.
 *
 * Only in full screen, where the toolbar floats over the picture instead of
 * sitting above it, and only for a pointer pressed against the very top of the
 * display and held there. Hovering is the wrong trigger for this: a remote
 * desktop keeps its own tab strip, menu bar and window buttons along that same
 * edge, so a toolbar that appears whenever the pointer is near it appears
 * exactly over what someone was reaching for — and then takes the click.
 *
 * Two pixels and half a second is deliberately hard to do by accident and
 * trivial on purpose: the pointer stops dead at the edge of a screen, so
 * shoving it there and waiting is a gesture, while passing through on the way
 * to a tab is not. Moving down past the toolbar puts it away at once.
 */
export function useToolbarReveal(pane: RefObject<HTMLDivElement | null>): boolean {
  const [out, setOut] = useState(false)

  useEffect(() => {
    const element = pane.current
    if (!element) return
    let dwelling: number | undefined

    const onMove = (event: MouseEvent): void => {
      // Only this pane, and only while it is the one filling the screen.
      if (document.fullscreenElement !== element) {
        window.clearTimeout(dwelling)
        setOut(false)
        return
      }

      const top = element.getBoundingClientRect().top
      const y = event.clientY - top

      if (y <= EDGE) {
        // Already waiting; a second event should not restart the clock, or a
        // trembling hand never gets there.
        if (dwelling === undefined) {
          dwelling = window.setTimeout(() => {
            dwelling = undefined
            setOut(true)
          }, EDGE_DWELL)
        }
        return
      }

      window.clearTimeout(dwelling)
      dwelling = undefined
      // Left open while the pointer is still over the toolbar itself, so it
      // can be aimed at; anything below that puts it away.
      const toolbar = element.querySelector('.pane-toolbar')
      const height = toolbar?.getBoundingClientRect().height ?? 0
      if (y > height) setOut(false)
    }

    const onFullscreen = (): void => {
      window.clearTimeout(dwelling)
      dwelling = undefined
      setOut(false)
    }

    window.addEventListener('mousemove', onMove)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => {
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('fullscreenchange', onFullscreen)
      window.clearTimeout(dwelling)
    }
  }, [pane])

  return out
}
