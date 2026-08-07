import { describe, it, expect } from 'vitest'
import { EchoSuppressor } from './echoSuppressor'

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
const text = (b: Buffer): string => b.toString('utf8')

describe('EchoSuppressor', () => {
  it('removes the echoed line and lets the rest through', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    expect(text(s.push(buf('__td7 setup\r\nmax@box:~$ ')))).toBe('max@box:~$ ')
    expect(s.done).toBe(true)
  })

  it('takes the newline with it, so no blank line is left behind', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('X\r\nafter')))).toBe('after')
  })

  it('handles a bare LF as well as CRLF', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('X\nafter')))).toBe('after')
  })

  it('keeps whatever came before the echo', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('prompt$ X\r\nafter')))).toBe('prompt$ after')
  })

  it('waits across reads when the echo is split', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    expect(text(s.push(buf('__td7 se')))).toBe('')
    expect(s.done).toBe(false)
    expect(text(s.push(buf('tup\r\nrest')))).toBe('rest')
    expect(s.done).toBe(true)
  })

  it('passes everything through once it is done', () => {
    const s = new EchoSuppressor(buf('X'))
    s.push(buf('X\r\n'))
    expect(text(s.push(buf('X again')))).toBe('X again')
  })

  it('gives up rather than swallowing a screenful that never matches', () => {
    // A shell with echo disabled never sends it back; the user must still see
    // their output.
    const s = new EchoSuppressor(buf('never-appears'), 16)
    expect(text(s.push(buf('012345678901234567890')))).toBe('012345678901234567890')
    expect(s.done).toBe(true)
  })

  it('releases what it was holding when flushed', () => {
    const s = new EchoSuppressor(buf('__td7'))
    expect(text(s.push(buf('__t')))).toBe('')
    expect(text(s.flush())).toBe('__t')
    expect(s.done).toBe(true)
  })

  it('does not corrupt multi-byte characters split across reads', () => {
    // 'ы' is two bytes; a string-based matcher would mangle it here.
    const cyrillic = buf('привет')
    const s = new EchoSuppressor(buf('__td7'))
    const first = s.push(cyrillic.subarray(0, 5))
    const second = s.push(Buffer.concat([cyrillic.subarray(5), buf('__td7\r\n')]))
    expect(text(Buffer.concat([first, second]))).toBe('привет')
  })

  it('does nothing when given an empty expectation', () => {
    const s = new EchoSuppressor(Buffer.alloc(0))
    expect(s.done).toBe(true)
    expect(text(s.push(buf('anything')))).toBe('anything')
  })
})
