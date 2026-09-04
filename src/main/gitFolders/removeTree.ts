import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/**
 * Deletes a checkout, and never makes that the caller's problem.
 *
 * Two things learned the hard way on Windows.
 *
 * Git marks everything under `.git/objects` read-only — the files are named
 * after their own contents, so nothing has any business writing to them — and
 * on Windows a read-only file cannot be unlinked at all. `rm -rf` on a checkout
 * therefore fails with EPERM, and `force: true` does not help: it forgives a
 * file that is *missing*, not one that refuses to go. The attribute is cleared
 * first, which is what every tool that removes a git checkout on Windows ends
 * up doing.
 *
 * And it swallows what is left. Every caller here is tidying up — a clone from
 * before checkouts were shared, or one whose last folder has just been deleted —
 * so the worst case of failing is some disk space nobody reclaims. It reached
 * the user as `EPERM, Permission denied` in place of the inventory they had
 * asked to sync, because a successful clone was then undone by housekeeping.
 */
export function removeTree(dir: string): void {
  if (!existsSync(dir)) return
  try {
    if (process.platform === 'win32') clearReadOnly(dir)
    // The retries are for the other Windows habit: a file held open for a
    // moment longer by an antivirus scanner or by Explorer.
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    // Tidying up is not worth a failure the user has to read.
  }
}

/** Makes every file writable, so Windows will let go of it. */
function clearReadOnly(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory()) clearReadOnly(full)
      else chmodSync(full, 0o666)
    } catch {
      // A file that cannot even be stat'd is one the removal will report on.
    }
  }
}
