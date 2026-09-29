import type { GitFolderTree, SessionGroup, SessionProfile } from './types'

/**
 * A Sessions folder that mirrors a git inventory, and the arithmetic of what it
 * shows.
 *
 * Both sides need this and they must not disagree: the main process prunes the
 * parsed repository down to the chosen groups before writing it, and the window
 * ticks the boxes that produced that choice. A divergence here would show one
 * tree and connect to another.
 */

/** Node ids carry the folder and the repository path, so they survive a sync. */
export function gitGroupId(folderId: string, path: string): string {
  return `git:${folderId}:g:${path}`
}

export function gitHostId(folderId: string, name: string): string {
  return `git:${folderId}:h:${name}`
}

/** Whether an id names something a repository produced rather than a saved entry. */
export function isGitNode(id: string): boolean {
  return id.startsWith('git:')
}

/** Every node id belonging to one folder starts this way. */
export function gitNodePrefix(folderId: string): string {
  return `git:${folderId}:`
}

/** The inventory path a derived group id was built from, or undefined. */
export function groupPathOf(folderId: string, id: string): string | undefined {
  const prefix = gitGroupId(folderId, '')
  return id.startsWith(prefix) ? id.slice(prefix.length) : undefined
}

/**
 * Ticking a group ticks everything under it.
 *
 * Selecting `prod` and then being asked, group by group, about the twelve
 * subgroups it contains is not a choice anybody wants to make — and the ones
 * that appear in the repository next month would each have to be answered for
 * again. A subgroup can still be unticked on its own afterwards.
 */
export function descendantPaths(path: string, all: string[]): string[] {
  return all.filter((p) => p === path || p.startsWith(`${path}/`))
}

/**
 * What the previous choice becomes when the repository has moved on: what is
 * still there, what is new, and what has gone.
 *
 * A group that appears under a chosen parent counts as chosen — that is what
 * ticking the parent said — so it arrives ticked and marked as new rather than
 * waiting to be noticed.
 */
export function reconcileSelection(
  repoPaths: string[],
  previous: { included: string[]; known?: string[] }
): { included: string[]; newPaths: string[]; removedGroups: string[] } {
  const chosen = new Set(previous.included)
  /*
   * Which groups the repository held last time, not only which were taken. A
   * subgroup deliberately unticked under a ticked parent is not new, and must
   * not be quietly ticked again on the next sync. Folders written before this
   * was recorded fall back to the chosen ones, which errs towards calling a
   * group new — visible, and correctable in the dialog it is shown in.
   */
  const known = new Set(previous.known ?? previous.included)
  const newPaths = repoPaths.filter((p) => !known.has(p))
  const isNew = new Set(newPaths)
  return {
    included: repoPaths.filter(
      (p) => chosen.has(p) || (isNew.has(p) && hasChosenParent(p, chosen))
    ),
    newPaths,
    removedGroups: previous.included.filter((p) => !repoPaths.includes(p))
  }
}

/** Whether any ancestor of this path was part of the previous choice. */
function hasChosenParent(path: string, chosen: Set<string>): boolean {
  const parts = path.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    if (chosen.has(parts.slice(0, i).join('/'))) return true
  }
  return false
}

/**
 * Every host each group holds the way Ansible counts it: the ones it names
 * itself, and every host of every group beneath it, all the way down.
 *
 * Children are followed by name, not by where they sit in the file. An
 * inventory states a group's hosts once and then refers to the group by name
 * elsewhere — kubespray's `k8s_cluster: children: kube_node:` is a reference to
 * `kube_node`, not a second, empty group — and Ansible reads every mention of a
 * name as the one group. Parsed by path, the reference arrives with no hosts,
 * which is why ticking `k8s_cluster` on its own brought nothing in.
 *
 * Keyed by group id, so each place a name appears answers for the whole group.
 */
export function hostsWithChildren(full: GitFolderTree): Map<string, Set<string>> {
  const nameOf = new Map(full.groups.map((g) => [g.id, g.name]))
  const direct = new Map<string, Set<string>>()
  const children = new Map<string, Set<string>>()
  const entry = <T>(map: Map<string, Set<T>>, name: string): Set<T> => {
    const found = map.get(name)
    if (found) return found
    const made = new Set<T>()
    map.set(name, made)
    return made
  }

  for (const g of full.groups) {
    const parent = g.parentId ? nameOf.get(g.parentId) : undefined
    if (parent !== undefined) entry(children, parent).add(g.name)
  }
  for (const host of full.sessions) {
    const claims = full.memberships[host.id] ?? (host.groupId ? [host.groupId] : [])
    for (const id of claims) {
      const name = nameOf.get(id)
      if (name !== undefined) entry(direct, name).add(host.id)
    }
  }

  const done = new Map<string, Set<string>>()
  // Ansible refuses a group that contains itself; here it just stops the walk.
  const walking = new Set<string>()
  const collect = (name: string): Set<string> => {
    const cached = done.get(name)
    if (cached) return cached
    const hosts = new Set(direct.get(name))
    walking.add(name)
    for (const child of children.get(name) ?? []) {
      if (!walking.has(child)) for (const h of collect(child)) hosts.add(h)
    }
    walking.delete(name)
    done.set(name, hosts)
    return hosts
  }

  return new Map(full.groups.map((g) => [g.id, collect(g.name)]))
}

/**
 * The repository tree cut down to the chosen groups.
 *
 * A group whose parent was left out is not orphaned: it hangs off the nearest
 * chosen ancestor, and off the folder itself when there is none — so picking a
 * single deep group gives you that group, in the folder, rather than nothing.
 * A host survives if any chosen group names it, and takes its connection
 * settings from the last of those in Ansible's own order.
 *
 * With `includeChildHosts`, a chosen group also holds the hosts of the groups
 * beneath it, as `hostsWithChildren` counts them. A host a chosen group names
 * itself still takes its settings from that group; one that only arrives
 * through a child takes them from the chosen group that brought it.
 */
export function pruneTree(
  folderId: string,
  full: GitFolderTree,
  included: string[],
  includeChildHosts = false
): GitFolderTree {
  const chosen = new Set(included)
  const parentOf = new Map(full.groups.map((g) => [g.id, g.parentId]))
  const keptIds = new Set(
    full.groups.filter((g) => chosen.has(groupPathOf(folderId, g.id) ?? '')).map((g) => g.id)
  )

  const nearestKept = (from: string | null): string => {
    const seen = new Set<string>()
    let cursor = from
    while (cursor && !seen.has(cursor)) {
      if (keptIds.has(cursor)) return cursor
      seen.add(cursor)
      cursor = parentOf.get(cursor) ?? null
    }
    // Above the repository's own groups sits the folder the user made.
    return folderId
  }

  const groups: SessionGroup[] = full.groups
    .filter((g) => keptIds.has(g.id))
    .map((g) => ({ ...g, parentId: nearestKept(g.parentId) }))

  const inherited = includeChildHosts ? hostsWithChildren(full) : undefined
  const sessions: SessionProfile[] = []
  const memberships: Record<string, string[]> = {}
  for (const host of full.sessions) {
    const claims = (full.memberships[host.id] ?? (host.groupId ? [host.groupId] : [])).filter(
      (id) => keptIds.has(id)
    )
    const through = inherited
      ? groups.filter((g) => !claims.includes(g.id) && inherited.get(g.id)?.has(host.id))
      : []
    if (claims.length === 0 && through.length === 0) continue
    const primary = claims.length > 0 ? claims[claims.length - 1] : through[through.length - 1].id
    sessions.push({ ...host, groupId: primary })
    memberships[host.id] = [...claims, ...through.map((g) => g.id)]
  }

  return { groupId: folderId, groups, sessions, memberships }
}

/** Visible Git folders and host placement; stored auth inheritance stays intact. */
export function gitFolderLayout(
  trees: GitFolderTree[],
  folders: SessionGroup[]
): {
  visibleGroupIds: Set<string>
  hostsByGroup: Map<string, Set<string>>
} {
  const visibleGroupIds = new Set<string>()
  const hostsByGroup = new Map<string, Set<string>>()
  for (const tree of trees) {
    const grouped = folders.find((g) => g.id === tree.groupId)?.git?.showGroupFolders
    if (!grouped) {
      hostsByGroup.set(tree.groupId, new Set(tree.sessions.map((s) => s.id)))
      continue
    }
    for (const group of tree.groups) {
      visibleGroupIds.add(group.id)
      hostsByGroup.set(group.id, new Set())
    }
    for (const host of tree.sessions) {
      const claims = tree.memberships?.[host.id] ?? (host.groupId ? [host.groupId] : [])
      for (const id of claims) hostsByGroup.get(id)?.add(host.id)
    }
  }
  return { visibleGroupIds, hostsByGroup }
}
