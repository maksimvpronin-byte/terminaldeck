import { asProtocol, type Protocol } from '../../shared/protocols'
import type { AuthDefaults, SessionGroup, SessionProfile } from '../../shared/types'

export interface ParsedInventory {
  groups: SessionGroup[]
  hosts: SessionProfile[]
  /**
   * Host id to every group id that names it, in Ansible's own merge order:
   * parents before children, and alphabetically within a level.
   *
   * Ansible lets a host belong to any number of groups, so the tree has to be
   * able to show it under each of them. The host itself stays a single entity —
   * one id, one set of local overrides, one entry in a collection — and only
   * its placement is plural.
   */
  memberships: Record<string, string[]>
}

/** Vars as they appear in an inventory, group_vars or host_vars file. */
export type AnsibleVars = Record<string, unknown>

/**
 * Ids carry where a node came from, so a local override still addresses the same
 * host after the next sync. `prefix` says which kind of source that is: an
 * Inventory repository, or a Sessions folder tied to git.
 */
export function groupId(sourceId: string, path: string, prefix = 'inv'): string {
  return `${prefix}:${sourceId}:g:${path}`
}

export function hostId(sourceId: string, name: string, prefix = 'inv'): string {
  return `${prefix}:${sourceId}:h:${name}`
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (typeof value === 'number') return String(value)
  return undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

/**
 * A Jinja template or an inline `!vault` value: Ansible resolves those at run
 * time and we cannot, so they say nothing here rather than something wrong.
 */
function unresolved(value: unknown): boolean {
  return typeof value === 'string' && (value.includes('{{') || value.startsWith('$ANSIBLE_VAULT'))
}

/**
 * A string var as it can be used, or nothing. A template used to be taken as
 * written: `ansible_user: "{{ deploy_user }}"` became the login, and a key file
 * of `"{{ ssh_key }}"` both a path and key authentication, so the host failed
 * to connect instead of inheriting what its groups or the source say.
 */
function stated(value: unknown): string | undefined {
  return unresolved(value) ? undefined : str(value)
}

function inventoryPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '' || unresolved(value)) return undefined
  const port = num(value)
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Inventory port must be a whole number from 1 to 65535')
  }
  return port
}

/** Maps the Ansible connection vars we understand onto our own auth fields. */
export function varsToAuth(vars: AnsibleVars): AuthDefaults {
  const username = stated(vars.ansible_user) ?? stated(vars.ansible_ssh_user)
  const port = inventoryPort(vars.ansible_port) ?? inventoryPort(vars.ansible_ssh_port)
  const key = stated(vars.ansible_ssh_private_key_file) ?? stated(vars.ansible_private_key_file)
  return {
    ...(username ? { username } : {}),
    ...(port ? { port } : {}),
    // A stated key file implies key authentication; anything else is left to
    // the source's own settings rather than guessed at.
    ...(key ? { privateKeyPath: key, authMethod: 'privateKey' as const } : {})
  }
}

/**
 * What a host in this repository speaks, when the repository says so.
 *
 * Ansible has no word for this. Its own `ansible_connection` describes how
 * *Ansible* reaches a machine to run tasks on it, which is a different question
 * from how a person sits down in front of one — a Windows box is managed over
 * WinRM and used over RDP, and plenty of inventories say neither. So this reads
 * a variable of our own, `terminaldeck_protocol`, and reads nothing else:
 * guessing a protocol from a management transport would be right often enough
 * to be trusted and wrong often enough to strand somebody.
 *
 * Unset means the host is left alone, and `protocolOf` then calls it SSH — the
 * same answer every inventory host got before this existed.
 */
export function protocolFromVars(vars: AnsibleVars): Protocol | undefined {
  return asProtocol(vars.terminaldeck_protocol)
}

/**
 * The port such a host is reached on, which for a desktop is not the one
 * Ansible states.
 *
 * `ansible_port` is where *Ansible* connects: WinRM's 5985, or SSH's. Carrying
 * it into a desktop session dials the management port for a screen and fails in
 * a way that reads as a broken host rather than a mislabelled port. So an RDP
 * host takes `terminaldeck_port` when the inventory names one and otherwise
 * nothing at all, which leaves the client on 3389.
 */
function portForProtocol(
  auth: AuthDefaults,
  protocol: Protocol | undefined,
  vars: AnsibleVars
): AuthDefaults {
  if (protocol !== 'rdp') return auth
  const withoutAnsiblePort: AuthDefaults = { ...auth }
  delete withoutAnsiblePort.port
  const stated = inventoryPort(vars.terminaldeck_port)
  return stated ? { ...withoutAnsiblePort, port: stated } : withoutAnsiblePort
}

interface RawGroup {
  hosts?: Record<string, AnsibleVars | null> | null
  children?: Record<string, RawGroup | null> | null
  vars?: AnsibleVars | null
}

/**
 * Turns a parsed Ansible YAML inventory into our groups and sessions.
 *
 * `lookupVars` supplies group_vars/host_vars content, which is where connection
 * details usually live. It wins over vars written in the inventory itself, as in Ansible;
 * see `parseAnsibleInventories`.
 */
export function parseAnsibleInventory(
  doc: unknown,
  sourceId: string,
  lookupVars: (kind: 'group' | 'host', name: string) => AnsibleVars = () => ({}),
  prefix = 'inv'
): ParsedInventory {
  return parseAnsibleInventories([{ doc, lookupVars }], sourceId, prefix)
}

/** One inventory file, and where its group_vars and host_vars are looked up. */
export interface InventoryDocument {
  doc: unknown
  lookupVars: (kind: 'group' | 'host', name: string) => AnsibleVars
  /**
   * Where `lookupVars` reads from — the file's directory. Files beside one
   * another share their group_vars and host_vars, which are then read once;
   * a file elsewhere has its own, and they count for every group and host in
   * the inventory, as Ansible reads them, not only for the ones it names.
   */
  varsFrom?: string
}

/** Past this many nodes an inventory is refused rather than drawn. */
const MAX_NODES = 100_000

/**
 * Several inventory files read as the one inventory Ansible makes of them.
 *
 * To Ansible a group is its name. It is written down wherever it is convenient
 * — its hosts in one place, its vars in another, its children in a third, named
 * again as a child of some other group, again in the next file — and all of
 * that is one group. Here a group is a node in a tree, placed by its path, and
 * a group with two parents appears under both. So the files are first read for
 * what each group says, by name, and the tree is drawn from that afterwards:
 *
 * - a group's vars are gathered from every definition, in every file, over
 *   the group_vars beside every file, and every node of that name carries the
 *   result. Only the first definition, and the first file's group_vars, used
 *   to count;
 * - a group's children are its children at every node of that name: `prod`
 *   naming `web`, and `web` given `leaf` elsewhere, puts `leaf` under prod's
 *   web as well, and a host in `leaf` sees prod's login. The tree used to
 *   follow each definition as written, and prod never reached it;
 * - a group's hosts are its hosts at every node of that name, and a host's
 *   host_vars are read beside every file;
 * - `all` is there whether or not a file says so. Ansible makes every group a
 *   child of it, so its vars — from any file, or group_vars/all — reach every
 *   host. A file with no `all` key keeps its top groups at the top (their ids
 *   are what local settings are kept under), and they take all's vars
 *   underneath their own.
 */
export function parseAnsibleInventories(
  docs: InventoryDocument[],
  sourceId: string,
  prefix = 'inv'
): ParsedInventory {
  const now = Date.now()

  /** A group naming a host, carrying the vars stated at that mention. */
  interface Claim {
    group: string
    vars: AnsibleVars
  }
  interface Seen {
    name: string
    claims: Claim[]
  }
  const seen = new Map<string, Seen>()
  /** The vars each group states itself, by name, from every definition of it. */
  const statedOf = new Map<string, AnsibleVars>()
  /** Every place group_vars and host_vars are read from, once each, in file order. */
  const places = new Map<string, InventoryDocument['lookupVars']>()
  /** Each group's children by name, from every definition, in the order met. */
  const childrenOf = new Map<string, string[]>()
  /** The groups at the top of the tree: `all`, and the top groups of a file without it. */
  const roots: string[] = []

  const addOnce = (list: string[], name: string): void => {
    if (!list.includes(name)) list.push(name)
  }
  const isGroup = (value: unknown): value is RawGroup | null =>
    value === null || (typeof value === 'object' && !Array.isArray(value))

  docs.forEach(({ doc, lookupVars, varsFrom }, index) => {
    if (!doc || typeof doc !== 'object') return
    const place = varsFrom ?? `#${index}`
    if (!places.has(place)) places.set(place, lookupVars)

    const walk = (name: string, raw: RawGroup | null): void => {
      statedOf.set(name, { ...statedOf.get(name), ...(raw?.vars ?? {}) })

      for (const [hostName, inlineVars] of Object.entries(raw?.hosts ?? {})) {
        const key = hostId(sourceId, hostName, prefix)
        const entry: Seen = seen.get(key) ?? { name: hostName, claims: [] }
        entry.claims.push({ group: name, vars: inlineVars ?? {} })
        seen.set(key, entry)
      }

      for (const [childName, child] of Object.entries(raw?.children ?? {})) {
        const children = childrenOf.get(name) ?? []
        addOnce(children, childName)
        childrenOf.set(name, children)
        walk(childName, child)
      }
    }

    /*
     * Every key at the top level is a group, and `all` is only the one Ansible
     * gives a meaning to.
     *
     * This used to read `all` and stop, which quietly threw away every other
     * group in the file. That is not an exotic layout: writing the groups as
     * siblings of `all` rather than nesting them under `all.children` is the
     * ordinary way a Kubernetes inventory is laid out, and the hosts still
     * appeared — they are listed under `all.hosts` as well — so the tree looked
     * like it had worked and had simply lost every group in the repository.
     *
     * Ansible makes every group a child of `all`, so that is where they are put.
     * A file with no `all` at all keeps them at the top, as before.
     */
    const root = doc as Record<string, RawGroup | null>
    if ('all' in root) {
      addOnce(roots, 'all')
      walk('all', root.all)
      for (const [name, raw] of Object.entries(root)) {
        if (name === 'all' || !isGroup(raw)) continue
        const children = childrenOf.get('all') ?? []
        addOnce(children, name)
        childrenOf.set('all', children)
        walk(name, raw)
      }
    } else {
      for (const [name, raw] of Object.entries(root)) {
        if (!isGroup(raw)) continue
        addOnce(roots, name)
        walk(name, raw)
      }
    }
  })

  /*
   * The tree, drawn from what the groups said. A group under two parents is
   * placed under each, and its children with it; a group that is its own
   * ancestor, which Ansible refuses, stops where it would repeat.
   */
  const nodes = new Map<string, { id: string; name: string; parentId: string | null }>()
  const nodesOf = new Map<string, string[]>()
  const placeNode = (name: string, parentPath: string | null, above: Set<string>): void => {
    if (above.has(name)) return
    const path = parentPath ? `${parentPath}/${name}` : name
    const id = groupId(sourceId, path, prefix)
    if (nodes.has(id)) return
    if (nodes.size >= MAX_NODES) {
      throw new Error('This inventory places its groups in too many places to show')
    }
    nodes.set(id, {
      id,
      name,
      parentId: parentPath ? groupId(sourceId, parentPath, prefix) : null
    })
    nodesOf.set(name, [...(nodesOf.get(name) ?? []), id])
    const below = new Set(above).add(name)
    for (const child of childrenOf.get(name) ?? []) placeNode(child, path, below)
  }
  for (const name of roots) placeNode(name, null, new Set())

  /** group_vars or host_vars from every place, in file order. */
  const fromPlaces = (kind: 'group' | 'host', name: string): AnsibleVars =>
    [...places.values()].reduce<AnsibleVars>(
      (acc, lookup) => ({ ...acc, ...lookup(kind, name) }),
      {}
    )
  const gathered = new Map<string, AnsibleVars>()
  /**
   * A group's vars, by name: what the inventory states for it, under its
   * group_vars. Ansible reads the group_vars files after the inventory's own
   * vars — `group_vars/web.yml` saying `ansible_user: deploy` beats `vars:`
   * under `web` — and this had it the other way round. (Ansible goes one step
   * further, which a tree read by nearest group cannot: any group's
   * group_vars beat any other group's inline vars, `all` aside.)
   */
  const varsOf = (name: string): AnsibleVars => {
    let vars = gathered.get(name)
    if (!vars) {
      vars = { ...statedOf.get(name), ...fromPlaces('group', name) }
      gathered.set(name, vars)
    }
    return vars
  }

  /** What a node's group says, with `all` beneath a top group's own when nothing holds it. */
  const varsAt = (node: { name: string; parentId: string | null }): AnsibleVars =>
    node.parentId === null && node.name !== 'all'
      ? { ...varsOf('all'), ...varsOf(node.name) }
      : varsOf(node.name)

  const groups: SessionGroup[] = [...nodes.values()].map((node) => ({
    ...node,
    ...varsToAuth(varsAt(node))
  }))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const depthOf = (id: string): number => id.split('/').length

  const hosts: SessionProfile[] = []
  const memberships: Record<string, string[]> = {}
  for (const [key, entry] of seen) {
    /*
     * Every node of every group that names the host. Ansible merges group vars
     * parents-first and alphabetically within a level, with the last one read
     * winning; the same order picks the node whose connection settings this
     * host inherits — and between two nodes of one group, the later path.
     */
    const claimed = new Set<string>()
    for (const claim of entry.claims) {
      for (const id of nodesOf.get(claim.group) ?? []) claimed.add(id)
    }
    const ordered = [...claimed].sort(
      (a, b) =>
        depthOf(a) - depthOf(b) ||
        groupById.get(a)!.name.localeCompare(groupById.get(b)!.name) ||
        a.localeCompare(b)
    )
    if (ordered.length === 0) continue
    const primary = ordered[ordered.length - 1]
    // Vars stated at each mention are merged in the order of their groups, so
    // the group that supplies the settings is also the one that wins a conflict.
    const rank = new Map(ordered.map((id, i) => [groupById.get(id)!.name, i]))
    const inline = [...entry.claims]
      .sort((a, b) => (rank.get(a.group) ?? 0) - (rank.get(b.group) ?? 0))
      .reduce<AnsibleVars>((acc, claim) => ({ ...acc, ...claim.vars }), {})
    // host_vars over the inventory's own host vars, as Ansible reads them.
    const hostVars = { ...inline, ...fromPlaces('host', entry.name) }

    /*
     * Protocol is resolved here rather than inherited, and the difference
     * matters. Our own groups do not carry one — a group holds a Linux box and
     * a Windows one alike, which is why `protocolOf` asks only the host — but an
     * inventory states it once for a group and plainly means every host in it.
     * So the group chain is read at parse time and the answer written onto the
     * host, along the same order that decides which group's settings it takes.
     */
    const ancestors = new Map<string, SessionGroup>()
    for (const id of ordered) {
      let group = groupById.get(id)
      while (group && !ancestors.has(group.id)) {
        ancestors.set(group.id, group)
        group = group.parentId ? groupById.get(group.parentId) : undefined
      }
    }
    const fromGroups = [...ancestors.values()]
      .sort((a, b) => depthOf(a.id) - depthOf(b.id) || a.name.localeCompare(b.name))
      .reduce<AnsibleVars>((acc, group) => ({ ...acc, ...varsAt(group) }), {})
    const protocol = protocolFromVars(hostVars) ?? protocolFromVars(fromGroups)

    hosts.push({
      id: key,
      name: entry.name,
      ...(protocol ? { protocol } : {}),
      host: stated(hostVars.ansible_host) ?? entry.name,
      groupId: primary,
      tags: [],
      logToFile: false,
      portForwards: [],
      createdAt: now,
      updatedAt: now,
      ...portForProtocol(varsToAuth(hostVars), protocol, { ...fromGroups, ...hostVars })
    })
    memberships[key] = ordered
  }

  return { groups, hosts, memberships }
}
