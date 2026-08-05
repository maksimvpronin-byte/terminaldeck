import type { AuthDefaults, SessionGroup, SessionProfile } from '../../shared/types'

export interface ParsedInventory {
  groups: SessionGroup[]
  hosts: SessionProfile[]
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
  const claimed = new Set<string>()
  const now = Date.now()

  if (!doc || typeof doc !== 'object') return { groups, hosts }

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
      // Ansible lets a host sit in several groups; our tree has one parent, so
      // the first group that mentions it wins.
      if (claimed.has(hostName)) continue
      claimed.add(hostName)

      const hostVars = { ...lookupVars('host', hostName), ...(inlineVars ?? {}) }
      const auth = varsToAuth(hostVars)
      hosts.push({
        id: hostId(sourceId, hostName),
        name: hostName,
        host: str(hostVars.ansible_host) ?? hostName,
        groupId: id,
        tags: [],
        logToFile: false,
        portForwards: [],
        createdAt: now,
        updatedAt: now,
        ...auth
      })
    }

    for (const [childName, child] of Object.entries(raw?.children ?? {})) {
      walk(childName, child, path)
    }
  }

  // The conventional root is `all`, but a file may list top-level groups directly.
  const root = doc as Record<string, RawGroup | null>
  if (root.all) walk('all', root.all, null)
  else for (const [name, raw] of Object.entries(root)) walk(name, raw, null)

  return { groups, hosts }
}
