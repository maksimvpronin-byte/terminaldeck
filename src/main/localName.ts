import { basename, isAbsolute, relative, resolve, sep } from 'path'

/**
 * Names that arrive from somewhere else — a remote directory listing, a remote
 * path, a repository — and become a place on this machine's disk.
 *
 * A name is text chosen by whoever controls the far end. On a Unix server `\`
 * and `:` are ordinary characters, so `..\..\evil.dll` is one legal file name
 * there and two steps up a directory tree here. `report.txt:hidden` is one file
 * on Linux and an NTFS alternate data stream on Windows. `NUL` is a file on
 * Linux and a device that swallows everything written to it on Windows. None of
 * these is exotic for a server that wants to be unpleasant.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/

/** Why a single path segment cannot be used on this platform, or null if it can. */
function unsafeSegment(name: string, platform: NodeJS.Platform): string | null {
  if (!name) return 'empty'
  if (name === '.' || name === '..') return 'relative'
  if (name.includes('\0')) return 'NUL byte'
  if (name.includes('/')) return 'separator'
  if (platform === 'win32') {
    if (WINDOWS_FORBIDDEN.test(name)) return 'character Windows does not allow'
    // Windows strips these on the way in, so `a.` and `a` are the same file.
    if (/[. ]$/.test(name)) return 'trailing dot or space'
    if (WINDOWS_RESERVED.test(name)) return 'reserved device name'
  }
  return null
}

/**
 * Joins one name from elsewhere to a local directory, or refuses.
 *
 * Refusing rather than repairing, for anything that is a copy of a tree: a
 * silently renamed file is a file that is not where the person will look for
 * it, and two different remote names could be repaired into the same local one.
 */
export function localChild(
  parent: string,
  name: string,
  platform: NodeJS.Platform = process.platform
): string {
  const root = resolve(parent)
  const target = resolve(root, name)
  const rel = relative(root, target)
  if (
    unsafeSegment(name, platform) ||
    basename(name) !== name ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`Refusing unsafe remote file name: ${JSON.stringify(name)}`)
  }
  return target
}

/**
 * A usable local name for a remote file, repaired rather than refused.
 *
 * For a single scratch copy — a file opened for editing — where the name only
 * has to look right in the editor's title bar and keep its extension. Nothing
 * else ever looks for it by name, so repairing costs nothing.
 */
export function safeLocalName(
  remoteName: string,
  platform: NodeJS.Platform = process.platform
): string {
  // eslint-disable-next-line no-control-regex
  let name = remoteName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  if (platform === 'win32') {
    name = name.replace(/[. ]+$/, '')
    if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  }
  if (!name || name === '.' || name === '..') return 'file'
  return name
}
