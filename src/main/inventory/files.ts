import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join } from 'path'
import { parse } from 'yaml'
import type { AnsibleVars } from './ansible'
import { insideCheckout } from './checkout'

/**
 * Finding and reading the YAML of a checkout.
 *
 * Shared by the two things that mirror a repository — an Inventory source and a
 * Sessions folder tied to git — because they must read a repository the same
 * way. The same paths, the same one-level directory scan, the same refusal to
 * step outside the checkout.
 */

export function isYaml(file: string): boolean {
  return ['.yml', '.yaml'].includes(extname(file).toLowerCase())
}

/** Reads `<dir>/<name>.yml` or every *.yml under `<dir>/<name>/`, as Ansible does. */
export function readVarsFor(
  baseDir: string,
  kind: 'group_vars' | 'host_vars',
  name: string
): AnsibleVars {
  const candidates: string[] = []
  const flat = join(baseDir, kind, `${name}.yml`)
  const flatYaml = join(baseDir, kind, `${name}.yaml`)
  const nested = join(baseDir, kind, name)

  if (existsSync(flat)) candidates.push(flat)
  if (existsSync(flatYaml)) candidates.push(flatYaml)
  if (existsSync(nested) && statSync(nested).isDirectory()) {
    for (const f of readdirSync(nested)) {
      if (isYaml(f)) candidates.push(join(nested, f))
    }
  }

  let vars: AnsibleVars = {}
  for (const file of candidates) {
    try {
      const parsed = parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') vars = { ...vars, ...(parsed as AnsibleVars) }
    } catch {
      // A broken vars file shouldn't sink the whole inventory.
    }
  }
  return vars
}

/** Every inventory file a configured path points at. */
export function resolveInventoryFiles(repoDir: string, paths: string[]): string[] {
  const files: string[] = []
  for (const rel of paths.length > 0 ? paths : ['.']) {
    const target = join(repoDir, rel)
    if (!insideCheckout(repoDir, target)) continue
    if (!existsSync(target)) continue
    if (statSync(target).isDirectory()) {
      for (const f of readdirSync(target)) {
        const full = join(target, f)
        // Only the directory itself; group_vars/ and host_vars/ are read separately.
        if (isYaml(f) && statSync(full).isFile()) files.push(full)
      }
    } else if (isYaml(target)) {
      files.push(target)
    }
  }
  return files
}

/** Said when a sync read the repository but found nothing it could parse. */
export function noInventoryFound(paths: string[]): string {
  return (
    `No .yml or .yaml files found at: ${paths.join(', ') || '(repo root)'}. ` +
    'A directory is read one level deep, and an inventory in INI format ' +
    '(often just named "hosts", with no extension) is not read at all.'
  )
}
