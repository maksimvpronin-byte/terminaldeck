export const DRAG_MIME = 'application/x-terminaldeck-item'

export type DragItem =
  | { kind: 'session'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'tab'; id: string }

/** Which edge of a pane a drop landed nearest, deciding how the pane splits. */
export type DropEdge = 'left' | 'right' | 'top' | 'bottom'

export function edgeFromPoint(rect: DOMRect, clientX: number, clientY: number): DropEdge {
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  const distances: Array<[DropEdge, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y]
  ]
  return distances.reduce((best, cur) => (cur[1] < best[1] ? cur : best))[0]
}

export function edgeToSplit(edge: DropEdge): {
  dir: 'row' | 'col'
  position: 'before' | 'after'
} {
  return {
    dir: edge === 'left' || edge === 'right' ? 'row' : 'col',
    position: edge === 'left' || edge === 'top' ? 'before' : 'after'
  }
}
