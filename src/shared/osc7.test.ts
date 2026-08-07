import { describe, it, expect } from 'vitest'
import { scanOsc7 } from './osc7'

const ESC = '\u001b'
const BEL = '\u0007'
/** A complete OSC 7 sequence, BEL-terminated unless told otherwise. */
const seq = (url: string, terminator = BEL): string => `${ESC}]7;${url}${terminator}`

describe('scanOsc7', () => {
  it('finds nothing in ordinary output', () => {
    expect(scanOsc7('total 4\ndrwxr-xr-x 2 max max\n')).toEqual({ path: undefined, rest: '' })
  })

  it('reads a path terminated by BEL', () => {
    expect(scanOsc7(seq('file://box/var/log')).path).toBe('/var/log')
  })

  it('reads a path terminated by ESC backslash', () => {
    expect(scanOsc7(seq('file://box/var/log', `${ESC}\\`)).path).toBe('/var/log')
  })

  it('ignores whatever hostname the shell claims', () => {
    expect(scanOsc7(seq('file://anything-at-all/srv')).path).toBe('/srv')
  })

  it('decodes percent escapes, so a path with a space arrives whole', () => {
    expect(scanOsc7(seq('file://box/home/max/my%20files')).path).toBe('/home/max/my files')
  })

  it('survives a stray percent that is not an escape', () => {
    expect(scanOsc7(seq('file://box/tmp/100%done')).path).toBe('/tmp/100%done')
  })

  it('takes the last path when several arrive at once', () => {
    const chunk = `${seq('file://box/first')}some output${seq('file://box/second')}`
    expect(scanOsc7(chunk).path).toBe('/second')
  })

  it('keeps an unfinished sequence for the next chunk', () => {
    const first = scanOsc7(`output${ESC}]7;file://box/var`)
    expect(first.path).toBeUndefined()
    expect(first.rest).toBe(`${ESC}]7;file://box/var`)
    // The caller prepends the tail before scanning the next chunk.
    expect(scanOsc7(`${first.rest}/log${BEL}`).path).toBe('/var/log')
  })

  it('reports a completed path even when another sequence is still arriving', () => {
    const scan = scanOsc7(`${seq('file://box/done')}${ESC}]7;file://box/partial`)
    expect(scan.path).toBe('/done')
    expect(scan.rest).toBe(`${ESC}]7;file://box/partial`)
  })

  it('keeps a start marker split mid-way across two reads', () => {
    // The chunk ends on a bare ESC; dropping it would lose the next sequence.
    expect(scanOsc7(`output${ESC}`).rest).toBe(ESC)
    expect(scanOsc7(`output${ESC}]`).rest).toBe(`${ESC}]`)
    expect(scanOsc7(`output${ESC}]7`).rest).toBe(`${ESC}]7`)
  })

  it('does not hoard output when no sequence is pending', () => {
    // Otherwise a chatty command would grow the buffer without bound.
    expect(scanOsc7('x'.repeat(10_000)).rest).toBe('')
  })

  it('ignores a malformed url without a path', () => {
    expect(scanOsc7(seq('file://box')).path).toBeUndefined()
    expect(scanOsc7(seq('http://box/var')).path).toBeUndefined()
  })
})
