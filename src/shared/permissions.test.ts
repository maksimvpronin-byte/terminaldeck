import { describe, it, expect } from 'vitest'
import {
  formatChanged,
  formatPermissions,
  isExecutable,
  kindOf,
  parseLongnameOwner,
  type ModeInfo
} from './permissions'

const file = (permissions: string): ModeInfo => ({
  permissions,
  isDirectory: false,
  isSymlink: false
})
const dir = (permissions: string): ModeInfo => ({
  permissions,
  isDirectory: true,
  isSymlink: false
})
const link = (permissions: string): ModeInfo => ({
  permissions,
  isDirectory: false,
  isSymlink: true
})

describe('formatPermissions', () => {
  it('renders the everyday modes', () => {
    expect(formatPermissions('644')).toBe('rw-r--r--')
    expect(formatPermissions('755')).toBe('rwxr-xr-x')
    expect(formatPermissions('600')).toBe('rw-------')
    expect(formatPermissions('777')).toBe('rwxrwxrwx')
  })

  it('leaves the entry type to the icon and the colour', () => {
    // Nine characters, never ten: no leading d/l/- the way `ls -l` prints it.
    expect(formatPermissions('755')).toHaveLength(9)
    expect(formatPermissions('')).toHaveLength(9)
  })

  it('pads a mode that lost its leading zeros', () => {
    // 0o044 comes back from toString(8) as "44", 0o004 as "4", 0 as "0".
    expect(formatPermissions('44')).toBe('---r--r--')
    expect(formatPermissions('4')).toBe('------r--')
    expect(formatPermissions('0')).toBe('---------')
  })

  it('shows the sticky bit, as on /tmp', () => {
    expect(formatPermissions('1777')).toBe('rwxrwxrwt')
  })

  it('shows setuid and setgid in place of the execute flag', () => {
    expect(formatPermissions('4755')).toBe('rwsr-xr-x')
    expect(formatPermissions('2755')).toBe('rwxr-sr-x')
    expect(formatPermissions('6755')).toBe('rwsr-sr-x')
  })

  it('capitalises a special bit whose execute flag is off', () => {
    expect(formatPermissions('4644')).toBe('rwSr--r--')
    expect(formatPermissions('1666')).toBe('rw-rw-rwT')
  })

  it('gives up visibly when the mode is not octal', () => {
    expect(formatPermissions('')).toBe('?????????')
    expect(formatPermissions('rwx')).toBe('?????????')
    expect(formatPermissions('99999')).toBe('?????????')
  })
})

describe('isExecutable', () => {
  it('is true when any execute bit is set', () => {
    expect(isExecutable(file('755'))).toBe(true)
    expect(isExecutable(file('700'))).toBe(true)
    expect(isExecutable(file('111'))).toBe(true)
    expect(isExecutable(file('044'))).toBe(false)
    expect(isExecutable(file('644'))).toBe(false)
  })

  it('ignores directories, whose execute bit only means they can be entered', () => {
    expect(isExecutable(dir('755'))).toBe(false)
  })

  it('is false for a mode it cannot read', () => {
    expect(isExecutable(file('nope'))).toBe(false)
  })
})

describe('formatChanged', () => {
  it('pads every field so the column lines up', () => {
    expect(formatChanged(new Date(2026, 7, 11, 14, 35, 2).getTime())).toBe('11.08.2026 14:35:02')
    expect(formatChanged(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('01.01.2026 00:00:00')
  })

  it('draws nothing when the server sent no time', () => {
    // A zero mtime is "unknown", not midnight in 1970.
    expect(formatChanged(0)).toBe('')
    expect(formatChanged(Number.NaN)).toBe('')
  })
})

describe('parseLongnameOwner', () => {
  it('reads owner and group out of an ls -l line', () => {
    expect(
      parseLongnameOwner('-rw-r--r--    1 postgres postgres     2048 Aug 11 14:35 sync.log')
    ).toEqual({ owner: 'postgres', group: 'postgres' })
  })

  it('takes numeric ids as the names they stand in for', () => {
    expect(parseLongnameOwner('drwxr-xr-x   2 0        0            4096 Jan  1  2020 etc')).toEqual(
      { owner: '0', group: '0' }
    )
  })

  it('reads a line whose mode carries setuid or a sticky bit', () => {
    expect(
      parseLongnameOwner('-rwsr-xr-x 1 root root 166056 Feb 21  2024 sudo')
    ).toEqual({ owner: 'root', group: 'root' })
    expect(
      parseLongnameOwner('drwxrwxrwt 8 root root 4096 Aug 11 13:00 tmp')
    ).toEqual({ owner: 'root', group: 'root' })
  })

  it('refuses a line that is not a listing, rather than guessing', () => {
    // longname is specified as free text; a server that sends something else
    // must fall back to the numeric id, not have fields invented for it.
    expect(parseLongnameOwner('')).toBeNull()
    expect(parseLongnameOwner('sync.log')).toBeNull()
    expect(parseLongnameOwner('total 48')).toBeNull()
    expect(parseLongnameOwner('postgres postgres 2048 Aug 11 14:35 sync.log')).toBeNull()
  })
})

describe('kindOf', () => {
  it('calls out a symlink before asking anything about its target', () => {
    expect(kindOf(link('777'))).toBe('symlink')
    expect(kindOf({ permissions: '755', isDirectory: true, isSymlink: true })).toBe('symlink')
  })

  it('separates directories, executables and plain files', () => {
    expect(kindOf(dir('755'))).toBe('directory')
    expect(kindOf(file('755'))).toBe('executable')
    expect(kindOf(file('644'))).toBe('file')
  })
})
