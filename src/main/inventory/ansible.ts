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
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value)
  }
  return undefined
}

/** Maps the Ansible connection vars we understand onto our own auth fields. */
export function varsToAuth(vars: AnsibleVars): AuthDefaults {
  const username = str(vars.ansible_user) ?? str(vars.ansible_ssh_user)
  const port = num(vars.ansible_port) ?? num(vars.ansible_ssh_port)
  const key = str(vars.ansible_ssh_private_key_file) ?? str(vars.ansible_private_key_file)
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
  const stated = num(vars.terminaldeck_port)
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
 * details usually live; inline vars take precedence over it, matching Ansible.
 */
export function parseAnsibleInventory(
  doc: unknown,
  sourceId: string,
  lookupVars: (kind: 'group' | 'host', name: string) => AnsibleVars = () => ({}),
  prefix = 'inv'
): ParsedInventory {
  const groups: SessionGroup[] = []
  const hosts: SessionProfile[] = []
  const memberships: Record<string, string[]> = {}
  const now = Date.now()

  if (!doc || typeof doc !== 'object') return { groups, hosts, memberships }

  /** One group naming a host, carrying the vars stated at that mention. */
  interface Claim {
    id: string
    depth: number
    name: string
    vars: AnsibleVars
    /** The group's own vars, kept for the one setting a host cannot inherit. */
    groupVars: AnsibleVars
  }
  const seen = new Map<string, { name: string; claims: Claim[] }>()

  const walk = (name: string, raw: RawGroup | null, parentPath: string | null): void => {
    const path = parentPath ? `${parentPath}/${name}` : name
    const id = groupId(sourceId, path, prefix)
    const vars = { ...lookupVars('group', name), ...(raw?.vars ?? {}) }

    groups.push({
      id,
      name,
      parentId: parentPath ? groupId(sourceId, parentPath, prefix) : null,
      ...varsToAuth(vars)
    })

    for (const [hostName, inlineVars] of Object.entries(raw?.hosts ?? {})) {
      const key = hostId(sourceId, hostName, prefix)
      const entry = seen.get(key) ?? { name: hostName, claims: [] }
      entry.claims.push({
        id,
        depth: path.split('/').length,
        name,
        vars: inlineVars ?? {},
        groupVars: vars
      })
      seen.set(key, entry)
    }

    for (const [childName, child] of Object.entries(raw?.children ?? {})) {
      walk(childName, child, path)
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
  const isGroup = (value: unknown): value is RawGroup | null =>
    value === null || (typeof value === 'object' && !Array.isArray(value))

  if ('all' in root) {
    walk('all', root.all, null)
    for (const [name, raw] of Object.entries(root)) {
      if (name !== 'all' && isGroup(raw)) walk(name, raw, 'all')
    }
  } else {
    for (const [name, raw] of Object.entries(root)) {
      if (isGroup(raw)) walk(name, raw, null)
    }
  }

  for (const [key, entry] of seen) {
    // Ansible merges group vars parents-first and alphabetically within a level,
    // with the last one read winning. The same order picks the group whose
    // connection settings this host inherits.
    const ordered = [...entry.claims].sort(
      (a, b) => a.depth - b.depth || a.name.localeCompare(b.name)
    )
    const primary = ordered[ordered.length - 1]
    // Vars stated at each mention are merged along that same order, so the
    // group that supplies the settings is also the one that wins a conflict.
    const inline = ordered.reduce<AnsibleVars>((acc, claim) => ({ ...acc, ...claim.vars }), {})
    const hostVars = { ...lookupVars('host', entry.name), ...inline }

    /*
     * Protocol is resolved here rather than inherited, and the difference
     * matters. Our own groups do not carry one — a group holds a Linux box and
     * a Windows one alike, which is why `protocolOf` asks only the host — but an
     * inventory states it once for a group and plainly means every host in it.
     * So the group chain is read at parse time and the answer written onto the
     * host, along the same order that decides which group's settings it takes.
     */
    const fromGroups = ordered.reduce<AnsibleVars>((acc, c) => ({ ...acc, ...c.groupVars }), {})
    const protocol = protocolFromVars(hostVars) ?? protocolFromVars(fromGroups)

    hosts.push({
      id: key,
      name: entry.name,
      ...(protocol ? { protocol } : {}),
      host: str(hostVars.ansible_host) ?? entry.name,
      groupId: primary.id,
      tags: [],
      logToFile: false,
      portForwards: [],
      createdAt: now,
      updatedAt: now,
      ...portForProtocol(varsToAuth(hostVars), protocol, { ...fromGroups, ...hostVars })
    })
    memberships[key] = [...new Set(ordered.map((c) => c.id))]
  }

  return { groups, hosts, memberships }
}
