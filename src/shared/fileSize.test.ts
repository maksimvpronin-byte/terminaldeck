import { describe, it, expect } from 'vitest'
import { formatSize } from './fileSize'

describe('a size in front of someone', () => {
  it('leaves small files in bytes, unrounded', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(1)).toBe('1 B')
    expect(formatSize(1023)).toBe('1023 B')
  })

  it('steps up a unit at a time', () => {
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1024 ** 2)).toBe('1.0 MB')
    expect(formatSize(1024 ** 3)).toBe('1.0 GB')
    expect(formatSize(1024 ** 4)).toBe('1.0 TB')
  })

  it('keeps one decimal place, so 1.5 GB is not 2 GB', () => {
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB')
  })

  /** Powers of 1024, not of 1000 — a file manager, not a disk vendor. */
  it('counts in powers of 1024', () => {
    expect(formatSize(1000)).toBe('1000 B')
    expect(formatSize(1_000_000)).toBe('976.6 KB')
  })

  /** There is no PB unit, so the largest one has to keep counting. */
  it('stays in terabytes past the end of the list', () => {
    expect(formatSize(1024 ** 5)).toBe('1024.0 TB')
  })
})
