/**
 * The walk that credentials, desktop settings and appearance are all looked
 * up along: the item itself, then the group it sits in, then that group's
 * parent, and so on. Nearest definition wins.
 *
 * Kept generic because each opts out through its own flag (`inheritAuth`,
 * `inheritRdp`, `inheritAppearance`) but all must agree on the shape of the
 * walk — including the guard against a group cycle, which would otherwise
 * hang the renderer.
 *
 * A host an inventory puts in groups beyond one chain reads them all. Ansible
 * reads every group a host is in and all their parents, in one order —
 * shallower first, by name within a level — and the last to state a setting
 * wins. So for a host with `groupOrder` every group it reaches is read in
 * that order, latest first, each as it stands with its local settings, and
 * what lies above the inventory's groups — a source's own settings, a folder
 * of the user's — comes after them, from whichever walk got there. The
 * desktop settings and the look of such a host used to come from the group it
 * hangs off alone: a gateway set on a, with the host placed under z, was lost.
 */
export function inheritanceChain<T>(
  own: T,
  groupId: string | null,
  groups: Array<T & { id: string; parentId: string | null }>,
  optedOut: (level: T) => boolean
): T[] {
  // Opted out: the item stands on its own settings alone.
  if (optedOut(own)) return [own]

  type Group = T & {
    id: string
    parentId: string | null
    allId?: string
    repoParentId?: string
    frozen?: Record<string, Group>
  }
  const walked = own as T & {
    groupOrder?: string[]
    memberOf?: string[]
    frozen?: Record<string, Group>
  }
  const byId = new Map(groups.map((g) => [g.id, g as Group]))
  /*
   * Groups a git folder left out, read in their place. The host and every
   * group reached bring the ones they sit below; see SessionGroup.frozen.
   */
  const frozen = new Map(Object.entries(walked.frozen ?? {}))
  const lookup = (id: string | null | undefined): Group | undefined =>
    id ? (byId.get(id) ?? frozen.get(id)) : undefined
  /*
   * The next step up. A top group below another file's all goes there first,
   * and all leads on to the same parent; a group a git folder hangs lower
   * goes to its parent in the repository.
   */
  const above = (level: { allId?: string; repoParentId?: string }, parentId: string | null) =>
    lookup(level.allId)?.id ?? lookup(level.repoParentId)?.id ?? parentId

  // Up from each start, in the order found. A group that opts out still
  // gives its own values, but the walk stops there rather than going on.
  const reached: Group[] = []
  const seen = new Set<string>()
  const starts = [
    above(own as Group, groupId),
    ...(walked.groupOrder ? (walked.memberOf ?? []) : [])
  ]
  for (const start of starts) {
    let id = start
    let group = lookup(id)
    while (id && group && !seen.has(id)) {
      seen.add(id)
      reached.push(group)
      for (const [key, level] of Object.entries(group.frozen ?? {})) {
        if (!frozen.has(key)) frozen.set(key, level)
      }
      if (optedOut(group)) break
      id = above(group, group.parentId)
      group = lookup(id)
    }
  }
  if (!walked.groupOrder) return [own, ...reached]
  const listed = new Set(walked.groupOrder)
  const found = new Set(reached.map((g) => g.id))
  const inventory = [...walked.groupOrder]
    .reverse()
    .filter((id) => found.has(id))
    .map((id) => lookup(id)!)
  return [own, ...inventory, ...reached.filter((g) => !listed.has(g.id))]
}
