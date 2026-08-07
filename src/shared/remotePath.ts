/**
 * POSIX paths on the far side of an SFTP connection.
 *
 * These are string operations only — no filesystem, no round trip. Anything that
 * needs the server's own answer (`~`, symlinks, whether a path exists at all)
 * goes through `realpath` instead; this is for drawing breadcrumbs and stepping
 * up a level, where a round trip per keystroke would be silly.
 */

/** Collapses slashes and resolves `.` and `..` without consulting the server. */
export function normalizeRemotePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // A leading `..` on a relative path has nowhere to go, so it is kept.
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (absolute) return `/${joined}`
  return joined || '.'
}

/** The directory holding `path`; the root is its own parent. */
export function parentOf(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/' || normalized === '.') return normalized
  const cut = normalized.lastIndexOf('/')
  if (cut < 0) return '.'
  return cut === 0 ? '/' : normalized.slice(0, cut)
}

/** The last segment, for naming a file without splitting at the call site. */
export function baseNameOf(path: string): string {
  const normalized = normalizeRemotePath(path)
  if (normalized === '/') return '/'
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Joins a directory and a child name, tolerating a trailing slash on the parent. */
export function joinRemote(parent: string, child: string): string {
  return normalizeRemotePath(`${parent}/${child}`)
}

export interface PathSegment {
  name: string
  /** The absolute path this crumb navigates to. */
  path: string
}

/** Breadcrumbs for a path, root first, the directory itself last. */
export function segmentsOf(path: string): PathSegment[] {
  const normalized = normalizeRemotePath(path)
  if (!normalized.startsWith('/')) return [{ name: normalized, path: normalized }]

  const crumbs: PathSegment[] = [{ name: '/', path: '/' }]
  let walked = ''
  for (const segment of normalized.split('/').filter(Boolean)) {
    walked = `${walked}/${segment}`
    crumbs.push({ name: segment, path: walked })
  }
  return crumbs
}
