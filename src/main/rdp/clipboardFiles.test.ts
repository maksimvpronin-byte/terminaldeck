import { describe, it, expect, vi } from 'vitest'

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

  it('keeps one path per line, CRLF, as text/uri-list is written', () => {
    expect(pathsToUris(['/tmp/a b.txt', '/tmp/c.txt'])).toBe(
      'file:///tmp/a%20b.txt\r\nfile:///tmp/c.txt'
    )
  })
})
