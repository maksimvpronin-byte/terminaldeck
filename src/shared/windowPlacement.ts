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
