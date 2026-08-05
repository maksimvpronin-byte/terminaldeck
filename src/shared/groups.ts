import type { SessionGroup } from './types'

/**
 * The chain of names above a group, as "Prod / Databases". Used wherever a bare
 * group name would be ambiguous — a flat picker, or a search result.
 *
 * Guards against a cycle in `parentId`, which a hand-edited store could contain.
 */
export function groupPath(
  groupId: string | null,
  groups: SessionGroup[],
  separator = ' / '
): string {
  const parts: string[] = []
  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const group = groups.find((g) => g.id === cursor)
    if (!group) break
    parts.unshift(group.name)
    cursor = group.parentId
  }
  return parts.join(separator)
}
