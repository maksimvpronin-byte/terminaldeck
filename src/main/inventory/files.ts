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

/** What Ansible takes for a vars file: these, or no extension at all. */
const VARS_EXTENSIONS = ['.yml', '.yaml', '.json']

/**
 * Reads a group's or a host's vars where Ansible looks for them: `<name>`,
 * `<name>.yml`, `<name>.yaml` or `<name>.json`, the first of those that is
 * there — and, a folder, every vars file in it and below, by name.
 *
 * Only the two YAML spellings and a folder were looked for, all at once, and
 * a file with no extension — what Ansible's own examples write — was not
 * read: a host's address, login and port were missing with nothing said.
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
  const base = join(baseDir, kind, name)
  // A folder's vars files, by name, folders within it too; hidden and backup
  // files are passed over, as Ansible passes them over.
  const folder = (dir: string, depth: number): void => {
    for (const f of readdirSync(dir).sort()) {
      if (f.startsWith('.') || f.endsWith('~')) continue
      const full = join(dir, f)
      if (!inside(full)) continue
      const info = statSync(full)
      if (info.isDirectory()) {
        if (depth < 8) folder(full, depth + 1)
      } else if (
        info.isFile() &&
        (extname(f) === '' || VARS_EXTENSIONS.includes(extname(f).toLowerCase()))
      ) {
        candidates.push(full)
      }
    }
  }
  for (const path of [base, ...VARS_EXTENSIONS.map((ext) => `${base}${ext}`)]) {
    if (!existsSync(path) || !inside(path)) continue
    if (statSync(path).isDirectory()) folder(path, 0)
    else candidates.push(path)
    break
  }

  let vars: AnsibleVars = {}
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8')
      // A file encrypted whole with ansible-vault: Ansible needs the vault
      // password to read it, and so would we. Skipped, as before, rather than
      // failing the sync of everything else.
      if (text.trimStart().startsWith('$ANSIBLE_VAULT')) continue
      const parsed = parse(text)
      if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('variables must be a mapping')
      }
      if (parsed) vars = { ...vars, ...(parsed as AnsibleVars) }
    } catch (err) {
      throw new Error(`Cannot read inventory variables from ${file}: ${(err as Error).message}`)
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
      for (const f of readdirSync(target).sort()) {
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
