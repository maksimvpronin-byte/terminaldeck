import { realpathSync } from 'fs'
import { resolve, sep } from 'path'

/**
 * Whether a path stated in an inventory source stays inside the checkout it
 * belongs to.
 *
 * The paths are relative and read as such, but `join` is happy to walk out of
 * the directory it was given: `../../../etc` resolves cleanly, and the reader
 * would then parse whatever YAML it found there and present it as hosts.
 *
 * Nobody types that. The reason it matters is that these paths do not have to
 * be typed — they arrive through an imported backup, or a configuration
 * somebody else prepared, the same way a repository address does.
 */
export function insideCheckout(repoDir: string, target: string): boolean {
  const root = resolve(repoDir)
  const full = resolve(target)
  // The separator is the whole trick: without it `/repos/one-secret` passes as
  // being inside `/repos/one`.
  return full === root || full.startsWith(root + sep)
}

/** The path with every link resolved, or null when there is nothing there. */
function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * The same question asked of the disk rather than of the text.
 *
 * A repository can commit a symlink, and cloning one recreates it:
 * `group_vars/all.yml -> /home/me/.aws/credentials.yml` is inside the checkout
 * by its name and nowhere near it by what it opens. So a path that exists is
 * judged by where it really lands. One that does not exist is judged by its
 * text, and there is nothing to read from it anyway.
 */
export function reallyInsideCheckout(repoDir: string, target: string): boolean {
  if (!insideCheckout(repoDir, target)) return false
  const realTarget = real(target)
  if (realTarget === null) return true
  const realRoot = real(repoDir) ?? resolve(repoDir)
  return insideCheckout(realRoot, realTarget)
}

/**
 * Whether a group or host name can stand for one file or directory name.
 *
 * The name comes from the inventory YAML, which comes from the repository —
 * `../../outside` is a valid key there, and joined into `host_vars/` it would
 * read a vars file from anywhere. Ansible itself allows only word characters,
 * dots and dashes in group names, so refusing separators costs nothing real.
 * A colon stays: `db.example.com:2222` is an ordinary host entry.
 */
export function isPlainName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  )
}
