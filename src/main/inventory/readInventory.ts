import { dirname } from 'path'
import { readFileSync } from 'fs'
import { parse } from 'yaml'
import { parseAnsibleInventory, type ParsedInventory } from './ansible'
import { readVarsFor, resolveInventoryFiles } from './files'

export interface InventoryRead {
  dir: string
  paths: string[]
  sourceId: string
  prefix: 'inv' | 'git'
  rootId: string
}

/** Runs in the inventory worker, including filesystem reads and YAML parsing. */
export function readInventory(request: InventoryRead): ParsedInventory & { files: string[] } {
  const files = resolveInventoryFiles(request.dir, request.paths)
  const groups = new Map<string, ParsedInventory['groups'][number]>()
  const hosts = new Map<string, ParsedInventory['hosts'][number]>()
  const memberships = new Map<string, Set<string>>()
  const vars = new Map<string, ReturnType<typeof readVarsFor>>()
  for (const file of files) {
    const base = dirname(file)
    const parsed = parseAnsibleInventory(
      parse(readFileSync(file, 'utf8')),
      request.sourceId,
      (kind, name) => {
        const key = JSON.stringify([base, kind, name])
        if (!vars.has(key))
          vars.set(key, readVarsFor(base, kind === 'group' ? 'group_vars' : 'host_vars', name))
        return vars.get(key)!
      },
      request.prefix
    )
    for (const group of parsed.groups) {
      if (!groups.has(group.id))
        groups.set(group.id, { ...group, parentId: group.parentId ?? request.rootId })
    }
    for (const host of parsed.hosts) if (!hosts.has(host.id)) hosts.set(host.id, host)
    for (const [host, ids] of Object.entries(parsed.memberships)) {
      const merged = memberships.get(host) ?? new Set<string>()
      for (const id of ids) merged.add(id)
      memberships.set(host, merged)
    }
  }
  return {
    files,
    groups: [...groups.values()],
    hosts: [...hosts.values()],
    memberships: Object.fromEntries([...memberships].map(([host, ids]) => [host, [...ids]]))
  }
}
