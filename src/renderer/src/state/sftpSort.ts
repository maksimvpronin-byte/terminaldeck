import type { SftpEntry } from '../../../shared/types'
import type { ColumnWidths } from './sftpLayout'

/**
 * The order the file browser lists a folder in, chosen by clicking a column
 * heading. Folders stay above files whichever column is chosen — the way every
 * file manager does it, and the way the panel always listed them.
 */

export type SortKey = keyof ColumnWidths

export interface SftpSort {
  key: SortKey
  descending: boolean
}

const SORT_KEY = 'sftp.sort'

export const DEFAULT_SORT: SftpSort = { key: 'name', descending: false }

/**
 * Size and date are wanted biggest and newest first nearly every time they are
 * clicked; the rest read naturally from the top of the alphabet.
 */
export function nextSort(current: SftpSort, key: SortKey): SftpSort {
  if (current.key === key) return { key, descending: !current.descending }
  return { key, descending: key === 'size' || key === 'changed' }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareBy(key: SortKey, a: SftpEntry, b: SftpEntry, byPath: boolean): number {
  switch (key) {
    case 'size':
      return a.size - b.size
    case 'changed':
      return a.mtime - b.mtime
    case 'perms':
      return parseInt(a.permissions, 8) - parseInt(b.permissions, 8)
    case 'owner':
      return collator.compare(a.owner, b.owner)
    case 'group':
      return collator.compare(a.group, b.group)
    case 'name':
      return byPath ? collator.compare(a.path, b.path) : collator.compare(a.name, b.name)
  }
}

/**
 * A sorted copy of `entries`. `byPath` sorts names by their whole path, for
 * search results gathered from many folders, where the name alone would mix
 * the folders together.
 */
export function sortEntries(entries: SftpEntry[], sort: SftpSort, byPath = false): SftpEntry[] {
  const sign = sort.descending ? -1 : 1
  return [...entries].sort(
    (a, b) =>
      Number(b.isDirectory) - Number(a.isDirectory) ||
      sign * compareBy(sort.key, a, b, byPath) ||
      // Equal on the chosen column: by name, so the order holds still between polls.
      collator.compare(a.path, b.path)
  )
}

export function sortFrom(raw: string | null): SftpSort {
  try {
    const stored = raw ? (JSON.parse(raw) as Partial<SftpSort>) : null
    const keys: SortKey[] = ['name', 'size', 'changed', 'perms', 'owner', 'group']
    if (stored && keys.includes(stored.key as SortKey)) {
      return { key: stored.key as SortKey, descending: stored.descending === true }
    }
  } catch {
    // A spoilt value is not worth failing over.
  }
  return DEFAULT_SORT
}

export function loadSort(): SftpSort {
  return sortFrom(localStorage.getItem(SORT_KEY))
}

export function saveSort(sort: SftpSort): void {
  localStorage.setItem(SORT_KEY, JSON.stringify(sort))
}
