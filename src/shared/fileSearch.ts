/**
 * What the file browser's search box means by a name, said once for all three
 * places that ask: the filter over the folder on screen, the walk through its
 * subfolders over SFTP, and `find` run on the server over SCP/Shell.
 *
 * A plain word matches anywhere in a name, as a filter box is expected to.
 * A pattern with `*` or `?` in it is a shell glob and matches the whole name,
 * so `*.log` finds logs and not `catalog.txt`. Case is ignored either way —
 * the same as `find -iname`, so the two walks agree on what they found.
 */

/** Whether the query is a glob rather than a word to look for inside names. */
export function isGlob(query: string): boolean {
  return /[*?]/.test(query)
}

/** The glob to hand to `find -iname`: a bare word is wrapped to match inside names. */
export function globFor(query: string): string {
  const wanted = query.trim()
  if (isGlob(wanted)) return wanted
  // `[`, `]` and `\` mean something to find; escaped, a word is only a word.
  return `*${wanted.replace(/[[\]\\]/g, '\\$&')}*`
}

/** A test for a single name, or null when the query is empty and everything matches. */
export function nameMatcher(query: string): ((name: string) => boolean) | null {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return null
  if (!isGlob(wanted)) return (name) => name.toLowerCase().includes(wanted)
  const source = wanted
    .split('')
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  const pattern = new RegExp(`^${source}$`, 's')
  return (name) => pattern.test(name.toLowerCase())
}

/**
 * Most matches a search brings back. A search from `/` for `*` would otherwise
 * list a whole server into the panel; past this the result says it was cut.
 */
export const SEARCH_LIMIT = 500
