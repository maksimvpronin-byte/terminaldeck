import type { SessionGroup } from './types'

/**
 * The colour something wears: its own, or the nearest folder's above it.
 *
 * Unlike a login, a colour is not opted out of — a host that stands alone on
 * its connection settings still sits in a red folder, and still wants to look
 * as though it does. A cycle in a broken tree ends the walk rather than hanging
 * it.
 */
export function colourOf(
  item: { color?: string },
  groupId: string | null,
  groups: Pick<SessionGroup, 'id' | 'parentId' | 'color'>[]
): string | undefined {
  if (item.color) return item.color
  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const group = groups.find((g) => g.id === cursor)
    if (!group) return undefined
    if (group.color) return group.color
    cursor = group.parentId
  }
  return undefined
}
