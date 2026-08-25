import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { FrameReader, Opcode, acceptFor, encodeFrame } from './wsframe'

const MASK = new Uint8Array([0x37, 0xfa, 0x21, 0x3d])

/** Strips a client frame back to its payload, the way a server would. */
function unmask(frame: Uint8Array, headerLength: number): Uint8Array {
  const mask = frame.subarray(headerLength, headerLength + 4)
  const payload = frame.slice(headerLength + 4)
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
  return payload
}

/** A frame as a server sends it: same layout, no mask. */
function fromServer(opcode: Opcode, payload: Uint8Array, final = true): Uint8Array {
  const lengthBytes = payload.length < 126 ? 0 : payload.length < 65536 ? 2 : 8
  const frame = new Uint8Array(2 + lengthBytes + payload.length)
  const view = new DataView(frame.buffer)
  frame[0] = (final ? 0x80 : 0) | opcode
  frame[1] = lengthBytes === 0 ? payload.length : lengthBytes === 2 ? 126 : 127
  if (lengthBytes === 2) view.setUint16(2, payload.length, false)
  if (lengthBytes === 8) view.setBigUint64(2, BigInt(payload.length), false)
  frame.set(payload, 2 + lengthBytes)
  return frame
}

describe('encodeFrame', () => {
  it('masks the payload, as a client must', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const frame = encodeFrame(Opcode.Binary, payload, MASK)
    expect(frame[0]).toBe(0x82) // FIN and binary
    expect(frame[1] & 0x80).toBe(0x80) // the mask bit
    expect(frame[1] & 0x7f).toBe(5)
    expect(Array.from(unmask(frame, 2))).toEqual([1, 2, 3, 4, 5])
  })

  it('uses a two-byte length past 125 bytes', () => {
    const frame = encodeFrame(Opcode.Binary, new Uint8Array(200), MASK)
    expect(frame[1] & 0x7f).toBe(126)
    expect(new DataView(frame.buffer).getUint16(2, false)).toBe(200)
    expect(unmask(frame, 4)).toHaveLength(200)
  })

  it('uses an eight-byte length past 65535', () => {
    const frame = encodeFrame(Opcode.Binary, new Uint8Array(70000), MASK)
    expect(frame[1] & 0x7f).toBe(127)
    expect(Number(new DataView(frame.buffer).getBigUint64(2, false))).toBe(70000)
    expect(unmask(frame, 10)).toHaveLength(70000)
  })

  it('refuses a mask that is not four bytes', () => {
    expect(() => encodeFrame(Opcode.Binary, new Uint8Array(1), new Uint8Array(3))).toThrow(
      /four bytes/
    )
  })
})

describe('FrameReader', () => {
  it('reads a whole frame', () => {
    const reader = new FrameReader()
    const frames = reader.push(fromServer(Opcode.Binary, new Uint8Array([9, 8, 7])))
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0].payload)).toEqual([9, 8, 7])
  })

  it('waits for a frame split across reads', () => {
    const reader = new FrameReader()
    const frame = fromServer(Opcode.Binary, new Uint8Array([1, 2, 3, 4]))
    // A header cut in half, then the rest a byte at a time.
    expect(reader.push(frame.subarray(0, 1))).toHaveLength(0)
    expect(reader.push(frame.subarray(1, 3))).toHaveLength(0)
    const done = reader.push(frame.subarray(3))
    expect(done).toHaveLength(1)
    expect(Array.from(done[0].payload)).toEqual([1, 2, 3, 4])
  })

  it('returns several frames arriving in one read', () => {
    const reader = new FrameReader()
    const two = new Uint8Array([
      ...fromServer(Opcode.Binary, new Uint8Array([1])),
      ...fromServer(Opcode.Binary, new Uint8Array([2]))
    ])
    expect(reader.push(two)).toHaveLength(2)
  })

  it('joins a fragmented message', () => {
    const reader = new FrameReader()
    reader.push(fromServer(Opcode.Binary, new Uint8Array([1, 2]), false))
    const done = reader.push(fromServer(Opcode.Continuation, new Uint8Array([3, 4])))
    expect(done).toHaveLength(1)
    expect(Array.from(done[0].payload)).toEqual([1, 2, 3, 4])
  })

  it('hands a control frame over without joining it to a fragment', () => {
    const reader = new FrameReader()
    reader.push(fromServer(Opcode.Binary, new Uint8Array([1]), false))
    const done = reader.push(fromServer(Opcode.Ping, new Uint8Array([0xaa])))
    expect(done).toHaveLength(1)
    expect(done[0].opcode).toBe(Opcode.Ping)
    // The fragmented message is still being assembled underneath it.
    const rest = reader.push(fromServer(Opcode.Continuation, new Uint8Array([2])))
    expect(Array.from(rest[0].payload)).toEqual([1, 2])
  })

  it('reads a large frame', () => {
    const reader = new FrameReader()
    const big = new Uint8Array(70000).fill(3)
    const done = reader.push(fromServer(Opcode.Binary, big))
    expect(done[0].payload).toHaveLength(70000)
  })

  it('refuses a continuation with nothing to continue', () => {
    const reader = new FrameReader()
    expect(() => reader.push(fromServer(Opcode.Continuation, new Uint8Array([1])))).toThrow(
      /continued a message it never started/
    )
  })

  it('reads a masked frame, even though a server should not send one', () => {
    const reader = new FrameReader()
    const frame = encodeFrame(Opcode.Binary, new Uint8Array([5, 6]), MASK)
    expect(Array.from(reader.push(frame)[0].payload)).toEqual([5, 6])
  })
})

describe('acceptFor', () => {
  it('matches the example in RFC 6455', () => {
    const sha1 = (input: string): string =>
      createHash('sha1').update(input, 'latin1').digest('base64')
    expect(acceptFor('dGhlIHNhbXBsZSBub25jZQ==', sha1)).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })
})
