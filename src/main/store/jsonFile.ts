import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * Reading and writing the small JSON files this application keeps.
 *
 * There are six of them — sessions, groups, collections, snippets, inventory,
 * known host keys, trusted certificates — and they were each doing this their
 * own way. Three went through a temporary file and a rename; three wrote in
 * place, which leaves a truncated file the moment anything interrupts the
 * write. The three that were careful are the three written least, and the host
 * tree, rewritten on every edit and every drag, was among the careless.
 *
 * So the rule lives here now, once, and a store added later gets it without
 * having to know it exists.
 */

/**
 * Writes so that a failure leaves the previous contents, not half of the new
 * ones.
 *
 * `rename` within a directory is atomic on every platform this ships to: the
 * name points at the old file or the new one, never at part of either. The
 * write that can fail — out of space, killed process, a full disk quota — is
 * the one to the temporary name, where failing costs nothing.
 */
export function writeJson(path: string, data: unknown): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

/**
 * Reads, and does not quietly discard a file it cannot parse.
 *
 * Returning the fallback from a failed parse is the obvious thing and the wrong
 * one: what the window shows is an application with nothing in it, which reads
 * as "everything is gone", and the first save after that writes the fallback
 * over the file that still held it. The damaged file is moved aside under a
 * name of its own instead, so what is left of it survives long enough to be
 * repaired by hand.
 *
 * A file that is simply absent is not damaged, and nothing is said about it.
 */
export function readJson<T>(path: string, fallback: () => T): T {
  if (!existsSync(path)) return fallback()
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    try {
      renameSync(path, `${path}.damaged-${Date.now()}`)
    } catch {
      // Nowhere to put it — a read-only directory, or it went between the two
      // calls. Starting from the fallback is still better than refusing to
      // start at all.
    }
    return fallback()
  }
}
