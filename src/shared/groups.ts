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

/**
 * Whether `groupId` sits anywhere under `ancestorId`, itself included.
 *
 * The one question every move of a folder has to ask: dropping a folder into
 * its own subtree — or beside a folder that lives there — would make it its own
 * descendant, and the whole branch would come away from the tree. Both the
 * move and the sort refuse on this answer, and it is written once because the
 * two disagreeing would mean one of them silently detaching a branch.
 *
 * Guards against a cycle in `parentId`, which a hand-edited store could hold.
 */
export function descendsFrom(
  groups: SessionGroup[],
  groupId: string | null,
  ancestorId: string
): boolean {
  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorId) return true
    seen.add(cursor)
    cursor = groups.find((g) => g.id === cursor)?.parentId ?? null
  }
  return false
}
