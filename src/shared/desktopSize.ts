import type { RdpView } from './types'

/** A pane, measured in CSS points — what `getBoundingClientRect` reports. */
export interface PaneSize {
  width: number
  height: number
}

export interface DesktopSize {
  /** In the far end's own pixels. */
  width: number
  height: number
  /**
   * Pixels asked for per CSS point. Returned because it is also what the far
   * end is told its density is, where it is told at all — the two can then
   * never disagree about how large the desktop is meant to look.
   */
  factor: number
}

/**
 * [MS-RDPEDISP] takes 200 to 8192 pixels and refuses an odd width.
 *
 * The height is rounded down to even as well, which the protocol does not ask
 * for: a server is free to round an odd one itself, and a desktop one pixel
 * taller than the pane is fitted into it with a bar along two edges — a
 * letterbox thin enough to read as a frame rather than as a size that was not
 * honoured. Giving up a pixel here costs nothing and asks for a size no server
 * has to adjust.
 */
const MIN_EDGE = 200
const MAX_EDGE = 8192

const evenWithinLimits = (pixels: number): number =>
  Math.min(MAX_EDGE, Math.max(MIN_EDGE, Math.round(pixels))) & ~1

/**
 * How big the desktop should be asked for, in the far end's own pixels.
 *
 * A pinned size is stated as it is. Otherwise the pane decides — measured in
 * CSS points, and multiplied by the screen's density when asked for: a pane
 * 1400 points wide is 2800 pixels on a Retina display, and asking for 1400 gets
 * a desktop the screen then magnifies, large and soft.
 *
 * The pane is measured in CSS points; a screen may have more pixels than that.
 * Asking for the pixels draws every one of them and is as sharp as the display
 * gets — and on a Retina display it is also half the size an ordinary monitor
 * gives, because Windows lays out a 20-pixel menu the same way whether a pixel
 * is a millimetre across or half of one. The far end can be told the density
 * instead, and by default is not: it is that machine being asked to lay itself
 * out differently, which is a decision to take per host. So unless a host asks
 * for it the size is what this end changes — fewer pixels, each drawn larger.
 *
 * Unstated, the magnification is the display's own density: a Retina pane asks
 * for exactly its points and draws each pixel as four, which is the size an
 * ordinary monitor gives. On a screen with one pixel per point that is a factor
 * of 1 — exactly the pane, as it has always been.
 *
 * Where the request would exceed the host's pixel budget the factor is reduced
 * further; it is never raised to meet it, since asking for more pixels than
 * were wanted is what the magnification was set to avoid.
 *
 * Returns nothing before the pane has a size, which is the case for one frame
 * after a tab is created.
 */
export function desktopSizeFor(
  look: RdpView | null,
  pane: PaneSize | null,
  density: number
): DesktopSize | null {
  if (look?.resolution === 'fixed') {
    // A pinned desktop is asked for exactly as it is stated, and nothing is
    // said about its density: the size is the whole of what was decided.
    return { width: look.desktopWidth, height: look.desktopHeight, factor: 1 }
  }
  if (!pane || pane.width < 1 || pane.height < 1) return null

  const dpr = density || 1
  const stated = look?.magnification
  const magnify = look?.sendDensity ? 1 : Math.min(4, Math.max(1, stated ? stated / 100 : dpr))
  const budget = (look?.pixelBudget ?? 3.5) * 1_000_000
  const wanted = dpr / magnify
  const full = pane.width * wanted * pane.height * wanted
  const factor = full <= budget ? wanted : wanted * Math.sqrt(budget / full)

  return {
    width: evenWithinLimits(pane.width * factor),
    height: evenWithinLimits(pane.height * factor),
    factor
  }
}
