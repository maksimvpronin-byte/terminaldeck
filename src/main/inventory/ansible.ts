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

export function groupId(sourceId: string, path: string): string {
  return `inv:${sourceId}:g:${path}`
}

export function hostId(sourceId: string, name: string): string {
  return `inv:${sourceId}:h:${name}`
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
  lookupVars: (kind: 'group' | 'host', name: string) => AnsibleVars = () => ({})
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
  }
  const seen = new Map<string, { name: string; claims: Claim[] }>()

  const walk = (name: string, raw: RawGroup | null, parentPath: string | null): void => {
    const path = parentPath ? `${parentPath}/${name}` : name
    const id = groupId(sourceId, path)
    const vars = { ...lookupVars('group', name), ...(raw?.vars ?? {}) }

    groups.push({
      id,
      name,
      parentId: parentPath ? groupId(sourceId, parentPath) : null,
      ...varsToAuth(vars)
    })

    for (const [hostName, inlineVars] of Object.entries(raw?.hosts ?? {})) {
      const key = hostId(sourceId, hostName)
      const entry = seen.get(key) ?? { name: hostName, claims: [] }
      entry.claims.push({ id, depth: path.split('/').length, name, vars: inlineVars ?? {} })
      seen.set(key, entry)
    }

    for (const [childName, child] of Object.entries(raw?.children ?? {})) {
      walk(childName, child, path)
    }
  }

  // The conventional root is `all`, but a file may list top-level groups directly.
  const root = doc as Record<string, RawGroup | null>
  if (root.all) walk('all', root.all, null)
  else for (const [name, raw] of Object.entries(root)) walk(name, raw, null)

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

    hosts.push({
      id: key,
      name: entry.name,
      host: str(hostVars.ansible_host) ?? entry.name,
      groupId: primary.id,
      tags: [],
      logToFile: false,
      portForwards: [],
      createdAt: now,
      updatedAt: now,
      ...varsToAuth(hostVars)
    })
    memberships[key] = [...new Set(ordered.map((c) => c.id))]
  }

  return { groups, hosts, memberships }
}
