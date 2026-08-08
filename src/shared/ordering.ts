/**
 * The sidebar shows hosts in the order they sit in the stored array, so sorting
 * the tree by hand is a permutation of that array. Both ends of the wire do the
 * permutation — the renderer to redraw at once, the main process to persist it —
 * so the arithmetic lives here rather than twice.
 */

/**
 * Moves `id` into the gap immediately before or after `targetId`. Everything
 * else keeps its relative order. A missing id, or a move onto itself, is a
 * no-op rather than an error: a stale drag must not scramble the list.
 */
export function moveRelativeTo<T extends { id: string }>(
  items: T[],
  id: string,
  targetId: string,
  place: 'before' | 'after'
): T[] {
  if (id === targetId) return items
  if (!items.some((x) => x.id === id) || !items.some((x) => x.id === targetId)) return items

  const moved = items.find((x) => x.id === id)!
  // The target's index is taken after the removal, so it already accounts for
  // dragging downwards past it.
  const rest = items.filter((x) => x.id !== id)
  const at = rest.findIndex((x) => x.id === targetId)
  const insertAt = place === 'before' ? at : at + 1
  return [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)]
}

/**
 * Reorders `items` to match `orderedIds`. Ids that are not mentioned keep their
 * relative order at the end instead of being dropped, so a stale list from the
 * renderer can only misplace an item, never lose one.
 */
export function applyOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const remaining = new Map(items.map((x) => [x.id, x]))
  const sorted: T[] = []
  for (const id of orderedIds) {
    const item = remaining.get(id)
    if (!item) continue
    sorted.push(item)
    remaining.delete(id)
  }
  return [...sorted, ...remaining.values()]
}
