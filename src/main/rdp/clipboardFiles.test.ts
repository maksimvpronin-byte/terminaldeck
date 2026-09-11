import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  clipboard: { readBuffer: () => Buffer.alloc(0), readText: () => '' }
}))

const { withEmptyAuthority, pathsToUris } = await import('./clipboardFiles')

describe('the file list handed to the RDP client', () => {
  /**
   * FreeRDP's parser reads everything after `file://` and insists the first
   * character be a slash. A share named in the authority field is therefore
   * refused outright — "URI format are not supported" — and the copy failed
   * with nothing to point at.
   */
  it('names a network share with an empty authority', () => {
    expect(withEmptyAuthority('file://server/share/report.txt')).toBe(
      'file:////server/share/report.txt'
    )
  })

  it('leaves a drive letter and a unix path as they are', () => {
    expect(withEmptyAuthority('file:///C:/Users/max/a.txt')).toBe('file:///C:/Users/max/a.txt')
    expect(withEmptyAuthority('file:///home/max/a.txt')).toBe('file:///home/max/a.txt')
  })

  /* Built from the running platform's own temporary directory: a path written
   * as `/tmp/x` is a path on the current drive when this runs on Windows, and
   * the first version of this test said so on every Windows build. */
  it('keeps one path per line, CRLF, as text/uri-list is written', () => {
    const lines = pathsToUris([join(tmpdir(), 'a b.txt'), join(tmpdir(), 'c.txt')]).split('\r\n')

    expect(lines).toHaveLength(2)
    expect(lines[0].startsWith('file:///') && lines[0].endsWith('/a%20b.txt')).toBe(true)
    expect(lines[1].endsWith('/c.txt')).toBe(true)
  })
})
