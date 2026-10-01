/** A rectangle in screen coordinates, as Electron gives and takes them. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a window lands on another display: the size it had, as far as that
 * display has room for it, in the middle of it.
 */
export function placeOn(bounds: Box, area: Box): Box {
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  }
}

/**
 * Where a window reopens, given where it was and the displays there are now.
 *
 * Where it was, when that is still on a display — the one it overlaps most —
 * and pulled inside that display's work area if it now hangs over an edge, as
 * after a change of resolution. A window that would come back on a display no
 * longer attached, or barely on one, opens in the middle of the first instead:
 * a title bar off every screen is a window nobody can reach.
 */
export function restorePlacement(
  saved: Box,
  areas: Box[],
  min: { width: number; height: number }
): Box | undefined {
  if (areas.length === 0) return undefined
  const wanted = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(min.width, Math.round(saved.width)),
    height: Math.max(min.height, Math.round(saved.height))
  }
  const overlap = (area: Box): { width: number; height: number } => ({
    width: Math.min(wanted.x + wanted.width, area.x + area.width) - Math.max(wanted.x, area.x),
    height: Math.min(wanted.y + wanted.height, area.y + area.height) - Math.max(wanted.y, area.y)
  })
  let best: Box | undefined
  let bestSize = 0
  for (const area of areas) {
    const { width, height } = overlap(area)
    if (width <= 0 || height <= 0) continue
    if (width * height > bestSize) {
      best = area
      bestSize = width * height
    }
  }
  const reachable = best && overlap(best).width >= 100 && overlap(best).height >= 50
  if (!best || !reachable) return placeOn(wanted, areas[0])
  const width = Math.min(wanted.width, best.width)
  const height = Math.min(wanted.height, best.height)
  return {
    x: Math.min(Math.max(wanted.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(wanted.y, best.y), best.y + best.height - height),
    width,
    height
  }
}
