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
