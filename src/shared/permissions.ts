/**
 * The mode bits SFTP reports, rendered the way a file manager shows them: the
 * rwx flags in their own column, and a kind the row can be coloured by.
 */

export interface ModeInfo {
  /** Octal digits as SFTPManager records them: special bits first, then rwx. */
  permissions: string
  isDirectory: boolean
  isSymlink: boolean
}

/** How a name is coloured. Checked in this order, the way `ls` does it. */
export type EntryKind = 'symlink' | 'directory' | 'executable' | 'file'

const TRIADS = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']

/** Shown when the server sent something that is not a mode at all. */
const UNKNOWN = '?????????'

/**
 * The nine rwx flags, without the leading type character `ls` prints. The row
 * already says what the entry is — icon for a directory, colour for a symlink —
 * so the column holds permissions and nothing else.
 */
export function formatPermissions(permissions: string): string {
  const digits = digitsOf(permissions)
  if (!digits) return UNKNOWN

  const special = Number(digits[0])
  return (
    withSpecialBit(TRIADS[Number(digits[1])], (special & 0b100) !== 0, 's', 'S') +
    withSpecialBit(TRIADS[Number(digits[2])], (special & 0b010) !== 0, 's', 'S') +
    withSpecialBit(TRIADS[Number(digits[3])], (special & 0b001) !== 0, 't', 'T')
  )
}

/**
 * `Number.toString(8)` drops leading zeros, so 0o644 arrives as "644" while
 * 0o044 arrives as "44" and a mode of zero as "0". Padding to four digits is
 * what keeps each position meaning what it should.
 */
function digitsOf(permissions: string): string | null {
  if (!/^[0-7]{1,4}$/.test(permissions)) return null
  return permissions.padStart(4, '0')
}

/**
 * setuid, setgid and the sticky bit are shown in place of the triad's execute
 * flag — capitalised when that flag is off, which is how `ls` says the bit is
 * set on something that cannot be executed anyway.
 */
function withSpecialBit(triad: string, set: boolean, whenExec: string, whenNot: string): string {
  if (!set) return triad
  return triad.slice(0, 2) + (triad[2] === 'x' ? whenExec : whenNot)
}

/**
 * True when any of the three execute bits is set. Directories carry execute to
 * mean "can be entered", which is not what the colouring is about, so they are
 * never counted here.
 */
export function isExecutable(info: ModeInfo): boolean {
  if (info.isDirectory) return false
  const digits = digitsOf(info.permissions)
  if (!digits) return false
  return [1, 2, 3].some((i) => (Number(digits[i]) & 0b001) !== 0)
}

/**
 * A modification time as `DD.MM.YYYY HH:MM:SS`, in the machine's own zone.
 *
 * Fixed width rather than locale-formatted, so the column stays in step and
 * two timestamps can be compared by eye. A zero mtime means the server sent
 * none, which is not the epoch and must not be drawn as 01.01.1970.
 */
export function formatChanged(mtime: number): string {
  if (!mtime) return ''
  const d = new Date(mtime)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/**
 * Owner and group out of the `longname` line SFTP sends beside each entry.
 *
 * The protocol carries only numeric uid and gid, so a name like `postgres` can
 * come from nowhere else. The catch is that longname is specified as "text to
 * display to the user" with no format at all — OpenSSH emits an `ls -l` line
 * and so do most servers, but nothing requires it. Hence the shape check: a
 * line that does not start with a mode is refused rather than guessed at, and
 * the caller falls back to the numeric id.
 */
export function parseLongnameOwner(longname: string): { owner: string; group: string } | null {
  const fields = longname.trim().split(/\s+/)
  // mode, links, owner, group, size, and a three-field date, then the name.
  if (fields.length < 8) return null
  if (!/^[-dlbcps][-rwxsStT]{9}/.test(fields[0])) return null
  return { owner: fields[2], group: fields[3] }
}

export function kindOf(info: ModeInfo): EntryKind {
  // A symlink is called out before anything else: what it points at is a
  // separate question, and the panel has not asked it.
  if (info.isSymlink) return 'symlink'
  if (info.isDirectory) return 'directory'
  return isExecutable(info) ? 'executable' : 'file'
}
