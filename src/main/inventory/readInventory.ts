import { dirname } from 'path'
import { readFileSync } from 'fs'
import { parse } from 'yaml'
import { parseAnsibleInventories, type InventoryDocument, type ParsedInventory } from './ansible'
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
  const vars = new Map<string, ReturnType<typeof readVarsFor>>()
  // Every file at once: a group defined in one and given its vars in another is
  // one group to Ansible. See parseAnsibleInventories.
  const docs: InventoryDocument[] = files.map((file) => {
    const base = dirname(file)
    return {
      doc: parse(readFileSync(file, 'utf8')),
      varsFrom: base,
      lookupVars: (kind, name) => {
        const key = JSON.stringify([base, kind, name])
        if (!vars.has(key))
          vars.set(
            key,
            readVarsFor(request.dir, base, kind === 'group' ? 'group_vars' : 'host_vars', name)
          )
        return vars.get(key)!
      }
    }
  })
  const parsed = parseAnsibleInventories(docs, request.sourceId, request.prefix)
  return {
    files,
    groups: parsed.groups.map((group) => ({
      ...group,
      parentId: group.parentId ?? request.rootId
    })),
    hosts: parsed.hosts,
    memberships: parsed.memberships
  }
}
