import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join } from 'path'
import { parse } from 'yaml'
import type { AnsibleVars } from './ansible'
import { isPlainName, reallyInsideCheckout } from './checkout'

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

/**
 * Reads `<dir>/<name>.yml` or every *.yml under `<dir>/<name>/`, as Ansible does.
 *
 * `repoDir` is the checkout every read must stay inside. The name is checked
 * before it is joined, and every file after it is found — by where it really
 * is, so a committed symlink cannot point a vars file at something outside.
 */
export function readVarsFor(
  repoDir: string,
  baseDir: string,
  kind: 'group_vars' | 'host_vars',
  name: string
): AnsibleVars {
  if (!isPlainName(name)) return {}
  const inside = (path: string): boolean => reallyInsideCheckout(repoDir, path)

  const candidates: string[] = []
  const flat = join(baseDir, kind, `${name}.yml`)
  const flatYaml = join(baseDir, kind, `${name}.yaml`)
  const nested = join(baseDir, kind, name)

  if (existsSync(flat) && inside(flat)) candidates.push(flat)
  if (existsSync(flatYaml) && inside(flatYaml)) candidates.push(flatYaml)
  if (existsSync(nested) && inside(nested) && statSync(nested).isDirectory()) {
    for (const f of readdirSync(nested)) {
      const full = join(nested, f)
      if (isYaml(f) && inside(full)) candidates.push(full)
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
    if (!existsSync(target)) continue
    if (!reallyInsideCheckout(repoDir, target)) continue
    if (statSync(target).isDirectory()) {
      for (const f of readdirSync(target)) {
        const full = join(target, f)
        // Only the directory itself; group_vars/ and host_vars/ are read separately.
        if (isYaml(f) && reallyInsideCheckout(repoDir, full) && statSync(full).isFile()) {
          files.push(full)
        }
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
