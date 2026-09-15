import { describe, it, expect } from 'vitest'
import { dirname, resolve } from 'path'
import { localChild, safeLocalName } from './localName'

/**
 * Names chosen by the far end, becoming places on this disk. Each case here is
 * an ordinary file name on a Unix server.
 */
describe('localChild', () => {
  const parent = resolve('downloads')

  it('joins an ordinary name', () => {
    expect(localChild(parent, 'report.txt')).toBe(resolve(parent, 'report.txt'))
  })

  it('refuses a name that walks out of the directory', () => {
    for (const name of ['..', '.', '', '../x', 'a/b', 'x\0y']) {
      expect(() => localChild(parent, name), name).toThrow(/unsafe/)
    }
  })

  it('refuses what only Windows reads as something else', () => {
    for (const name of [
      '..\\..\\evil.dll',
      'C:\\Windows\\x',
      'report.txt:hidden',
      'NUL',
      'con.txt',
      'LPT1',
      'trailing.',
      'trailing ',
      'a|b'
    ]) {
      expect(() => localChild(parent, name, 'win32'), name).toThrow(/unsafe/)
    }
  })

  it('leaves those names alone where they are ordinary', () => {
    for (const name of ['report.txt:hidden', 'NUL', 'trailing.']) {
      expect(localChild(parent, name, 'linux'), name).toBe(resolve(parent, name))
    }
  })
})

describe('safeLocalName', () => {
  it('keeps an ordinary name, extension and all', () => {
    expect(safeLocalName('sshd_config')).toBe('sshd_config')
    expect(safeLocalName('site.conf', 'win32')).toBe('site.conf')
  })

  it('repairs a name into one that stays put', () => {
    const repaired = safeLocalName('..\\..\\evil.dll', 'win32')
    expect(repaired).toBe('.._.._evil.dll')
    const dir = resolve('edit')
    expect(dirname(localChild(dir, repaired, 'win32'))).toBe(dir)
  })

  it('repairs device names, streams and trailing dots on Windows', () => {
    expect(safeLocalName('NUL', 'win32')).toBe('_NUL')
    expect(safeLocalName('com1.log', 'win32')).toBe('_com1.log')
    expect(safeLocalName('a.txt:stream', 'win32')).toBe('a.txt_stream')
    expect(safeLocalName('notes. ', 'win32')).toBe('notes')
  })

  it('falls back to a name when nothing usable is left', () => {
    for (const name of ['', '.', '..', '...']) {
      expect(safeLocalName(name, 'win32'), name).toBe('file')
    }
  })
})
