import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  clipboard: { readBuffer: () => Buffer.alloc(0), readText: () => '' }
}))

const { withEmptyAuthority, pathsToUris, readFileClipboard } = await import('./clipboardFiles')

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

/**
 * Each read used to start PowerShell afresh and compile its P/Invoke — close to
 * 300 ms, once a second and on every text copy. The helper now stays running,
 * so only the first read pays for starting it. Read only: nothing here writes
 * to the clipboard of the machine running the tests.
 */
// Not on CI: a runner's session may have no clipboard to read at all.
describe.runIf(process.platform === 'win32' && !process.env.CI)(
  'the Windows clipboard helper',
  () => {
    it('answers reads after the first without starting PowerShell again', async () => {
      const first = await readFileClipboard()
      expect(Array.isArray(first.paths)).toBe(true)
      expect(first.version).toMatch(/^\d+$/)

      const started = performance.now()
      for (let i = 0; i < 5; i++) await readFileClipboard()
      const each = (performance.now() - started) / 5

      expect(each).toBeLessThan(100)
    }, 20_000)
  }
)
