import { describe, it, expect } from 'vitest'
import { ChunkReader, encodeChunk } from './httpChunks'

const bytes = (reader: ChunkReader, input: string): string =>
  reader
    .push(Buffer.from(input, 'latin1'))
    .map((part) => Buffer.from(part).toString('latin1'))
    .join('|')

describe('encodeChunk', () => {
  it('states the length in hex and closes with a break', () => {
    expect(Buffer.from(encodeChunk(Buffer.from('hello'))).toString('latin1')).toBe('5\r\nhello\r\n')
  })

  it('uses hex, not decimal, for a length past nine', () => {
    expect(
      Buffer.from(encodeChunk(new Uint8Array(255)))
        .toString('latin1')
        .slice(0, 4)
    ).toBe('ff\r\n')
  })
})

describe('ChunkReader', () => {
  it('reads a whole chunk', () => {
    expect(bytes(new ChunkReader(), '5\r\nhello\r\n')).toBe('hello')
  })

  it('reads several chunks from one read', () => {
    expect(bytes(new ChunkReader(), '2\r\nab\r\n3\r\ncde\r\n')).toBe('ab|cde')
  })

  it('waits for a header split across reads', () => {
    const reader = new ChunkReader()
    expect(bytes(reader, '5')).toBe('')
    expect(bytes(reader, '\r\nhel')).toBe('hel')
    expect(bytes(reader, 'lo\r\n')).toBe('lo')
  })

  it('waits for a payload split across reads', () => {
    const reader = new ChunkReader()
    expect(bytes(reader, 'a\r\n0123')).toBe('0123')
    expect(bytes(reader, '456789\r\n1\r\nz\r\n')).toBe('456789|z')
  })

  it('ignores a chunk extension', () => {
    expect(bytes(new ChunkReader(), '5;whatever=1\r\nhello\r\n')).toBe('hello')
  })

  it('stops at the terminating chunk', () => {
    const reader = new ChunkReader()
    expect(bytes(reader, '2\r\nok\r\n0\r\n\r\n')).toBe('ok')
    expect(reader.finished).toBe(true)
  })

  it('refuses a size line that is not a number', () => {
    expect(() => new ChunkReader().push(Buffer.from('nonsense\r\n'))).toThrow(/chunk size/)
  })

  it('refuses a header that never ends, rather than buffering forever', () => {
    // A stream that is not chunked at all looks exactly like this.
    expect(() => new ChunkReader().push(Buffer.alloc(100, 0x41))).toThrow(/malformed chunk header/)
  })

  it('survives an empty push', () => {
    expect(bytes(new ChunkReader(), '')).toBe('')
  })
})
