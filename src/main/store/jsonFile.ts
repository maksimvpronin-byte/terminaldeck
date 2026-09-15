import { copyFileSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
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
 * One of those files, held in memory, changed only in a way that keeps memory
 * and disk saying the same thing.
 *
 * Every store used to change its data in place and then write it. When the
 * write failed — a full disk, a file locked by an antivirus scan — the change
 * stayed in memory anyway: the window showed a host that was saved nowhere, and
 * the next successful write of anything else saved it after all, long after the
 * error was reported and dismissed. So a change is made to a copy, the copy is
 * written, and only a copy that reached the disk becomes what the store holds.
 *
 * What `data` hands out is never changed afterwards — every change makes a new
 * one — so a snapshot is just a reference, and restoring one is writing it back.
 * That is what lets an import that fails halfway put every store back as it was.
 */
export class JsonDocument<T> {
  private current: T

  constructor(
    private readonly path: () => string,
    load: (path: string) => T
  ) {
    this.current = load(path())
  }

  get data(): T {
    return this.current
  }

  /** Applies `edit` to a copy, writes the copy, and only then keeps it. */
  change(edit: (draft: T) => void): T {
    const draft = structuredClone(this.current)
    edit(draft)
    writeJson(this.path(), draft)
    this.current = draft
    return draft
  }

  /** What the store holds now, to hand back to `restore`. */
  snapshot(): T {
    return this.current
  }

  restore(previous: T): void {
    writeJson(this.path(), previous)
    this.current = previous
  }
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
export function readJson<T>(
  path: string,
  fallback: () => T,
  /**
   * Whether what was parsed is this store's file at all. JSON that parses is
   * not yet a store: a file edited by hand into a list where an object belongs,
   * or with hosts that have no id, would otherwise be taken as it is and fail
   * later, in whatever code first reached for a field that is not there.
   */
  valid: (value: unknown) => boolean = () => true
): T {
  if (!existsSync(path)) return fallback()
  const text = readWithRetry(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    setAside(path)
    return fallback()
  }
  if (!valid(parsed)) {
    setAside(path)
    return fallback()
  }
  return parsed as T
}

/**
 * Reads a file that exists, and refuses rather than pretend when it cannot.
 *
 * A read that failed — the file locked by an antivirus scan, a permission taken
 * away — was treated like a file that did not parse: the store started empty,
 * and the first save wrote that emptiness over a file that was perfectly
 * intact. A read that fails is tried again briefly, since a scan lets go within
 * moments, and then reported as what it is.
 */
function readWithRetry(path: string): string {
  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return readFileSync(path, 'utf8')
    } catch (err) {
      last = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  throw new Error(
    `${path} exists but could not be read (${(last as Error).message}). It was left untouched; close whatever is holding it and start TerminalDeck again.`
  )
}

/**
 * Keeps a damaged file under a name of its own. Moved if it can be, copied if
 * it cannot — and if neither works, nothing starts on top of it: an empty store
 * saved over the only copy is the loss this exists to prevent.
 */
function setAside(path: string): void {
  const aside = `${path}.damaged-${Date.now()}`
  try {
    renameSync(path, aside)
    return
  } catch {
    // A read-only directory, or a file held open; try a copy.
  }
  try {
    copyFileSync(path, aside)
  } catch (err) {
    throw new Error(
      `${path} is damaged and could not be set aside (${(err as Error).message}); it was left untouched.`
    )
  }
}

/** Shape checks shared by the stores: a list of records that each carry a string key. */
export function isListOf(value: unknown, key: string): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)[key] === 'string'
    )
  )
}

/** An object whose named lists, where present, pass `isListOf`. */
export function hasLists(value: unknown, lists: Record<string, string>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.entries(lists).every(
    ([name, key]) => record[name] === undefined || isListOf(record[name], key)
  )
}

/** A record of strings to strings, the shape of the trust stores. */
export function isStringMap(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  )
}
