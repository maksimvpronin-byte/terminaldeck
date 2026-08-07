/**
 * The walk that both credentials and appearance are looked up along: the item
 * itself, then the group it sits in, then that group's parent, and so on.
 * Nearest definition wins.
 *
 * Kept generic because the two feature sets opt out through different flags
 * (`inheritAuth` and `inheritAppearance`) but must agree on the shape of the
 * walk — including the guard against a group cycle, which would otherwise hang
 * the renderer.
 */
export function inheritanceChain<T>(
  own: T,
  groupId: string | null,
  groups: Array<T & { id: string; parentId: string | null }>,
  optedOut: (level: T) => boolean
): T[] {
  const chain: T[] = [own]
  // Opted out: the item stands on its own settings alone.
  if (optedOut(own)) return chain

  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const group = groups.find((g) => g.id === cursor)
    if (!group) break
    chain.push(group)
    // A group that opted out still contributes its own values, but the walk
    // stops there rather than reaching its parent.
    if (optedOut(group)) break
    cursor = group.parentId
  }
  return chain
}
