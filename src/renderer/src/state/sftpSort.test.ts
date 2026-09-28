import { describe, expect, it } from 'vitest'
import type { SftpEntry } from '../../../shared/types'
import { DEFAULT_SORT, nextSort, sortEntries, sortFrom } from './sftpSort'

function entry(name: string, extra: Partial<SftpEntry> = {}): SftpEntry {
  return {
    name,
    path: `/srv/${name}`,
    isDirectory: false,
    isSymlink: false,
    size: 0,
    mtime: 0,
    permissions: '644',
    owner: 'root',
    group: 'root',
    ...extra
  }
}

const names = (list: SftpEntry[]): string[] => list.map((e) => e.name)

describe('sortEntries', () => {
  const list = [
    entry('b.log', { size: 10, mtime: 3000 }),
    entry('logs', { isDirectory: true, mtime: 1000 }),
    entry('a10.txt', { size: 30, mtime: 1000 }),
    entry('a9.txt', { size: 20, mtime: 2000 })
  ]

  it('lists folders first, then names in natural order', () => {
    expect(names(sortEntries(list, DEFAULT_SORT))).toEqual(['logs', 'a9.txt', 'a10.txt', 'b.log'])
  })

  it('sorts by date, newest first, keeping folders on top', () => {
    expect(names(sortEntries(list, { key: 'changed', descending: true }))).toEqual([
      'logs',
      'b.log',
      'a9.txt',
      'a10.txt'
    ])
  })

  it('sorts by size in either direction', () => {
    expect(names(sortEntries(list, { key: 'size', descending: false })).slice(1)).toEqual([
      'b.log',
      'a9.txt',
      'a10.txt'
    ])
    expect(names(sortEntries(list, { key: 'size', descending: true })).slice(1)).toEqual([
      'a10.txt',
      'a9.txt',
      'b.log'
    ])
  })

  it('compares rights as octal numbers', () => {
    const modes = [entry('x', { permissions: '755' }), entry('y', { permissions: '4755' })]
    expect(names(sortEntries(modes, { key: 'perms', descending: true }))).toEqual(['y', 'x'])
  })

  it('does not reorder the list it was given', () => {
    const copy = [...list]
    sortEntries(list, { key: 'size', descending: true })
    expect(list).toEqual(copy)
  })
})

describe('nextSort', () => {
  it('flips the direction on the same column', () => {
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ key: 'name', descending: true })
  })

  it('starts size and date at the largest and newest', () => {
    expect(nextSort(DEFAULT_SORT, 'changed')).toEqual({ key: 'changed', descending: true })
    expect(nextSort(DEFAULT_SORT, 'owner')).toEqual({ key: 'owner', descending: false })
  })
})

describe('sortFrom', () => {
  it('falls back on anything it cannot read', () => {
    expect(sortFrom(null)).toEqual(DEFAULT_SORT)
    expect(sortFrom('{')).toEqual(DEFAULT_SORT)
    expect(sortFrom('{"key":"colour"}')).toEqual(DEFAULT_SORT)
    expect(sortFrom('{"key":"size","descending":true}')).toEqual({
      key: 'size',
      descending: true
    })
  })
})
