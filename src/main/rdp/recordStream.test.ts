import { describe, it, expect, vi } from 'vitest'
import {
  createRecordReader,
  encodeCommand,
  readCursor,
  readFrame,
  RECORD
} from './recordStream'

/** One record, framed the way the client frames it. */
function record(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header[0] = type
  header.writeUInt32LE(payload.length, 1)
  return Buffer.concat([header, payload])
}

function frame(x: number, y: number, w: number, h: number): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt16LE(x, 0)
  head.writeUInt16LE(y, 2)
  head.writeUInt16LE(w, 4)
  head.writeUInt16LE(h, 6)
  return record(RECORD.frame, Buffer.concat([head, Buffer.alloc(w * h * 4, 0x7f)]))
}

describe('createRecordReader', () => {
  it('reads records that arrive whole', () => {
    const seen: Array<[number, number]> = []
    const reader = createRecordReader((type, payload) => seen.push([type, payload.length]))

    reader.push(Buffer.concat([record(RECORD.event, Buffer.from('{"e":"connected"}')), frame(0, 0, 2, 2)]))

    expect(seen).toEqual([
      [RECORD.event, 17],
      [RECORD.frame, 8 + 16]
    ])
  })

  it('reassembles a record split anywhere, including inside its length', () => {
    // The split that matters most: a pipe is free to hand over two bytes of a
    // four-byte length and nothing else for a while.
    const whole = frame(1, 2, 4, 4)
    for (const cut of [1, 2, 3, 4, 5, 6, 20, whole.length - 1]) {
      const seen: Buffer[] = []
      const reader = createRecordReader((_type, payload) => seen.push(payload))
      reader.push(whole.subarray(0, cut))
      expect(seen).toHaveLength(0)
      reader.push(whole.subarray(cut))
      expect(seen).toHaveLength(1)
      expect(readFrame(seen[0])).toMatchObject({ x: 1, y: 2, width: 4, height: 4 })
    }
  })

  it('reads several records out of one chunk', () => {
    const seen: number[] = []
    const reader = createRecordReader((type) => seen.push(type))
    reader.push(
      Buffer.concat([
        record(RECORD.event, Buffer.from('a')),
        record(RECORD.cursorState, Buffer.from([1])),
        frame(0, 0, 1, 1)
      ])
    )
    expect(seen).toEqual([RECORD.event, RECORD.cursorState, RECORD.frame])
  })

  it('hands over pixels that later chunks cannot change', () => {
    // A view into the held buffer would be rewritten by the next concat, and
    // the picture would change after it was drawn.
    const seen: Buffer[] = []
    const reader = createRecordReader((_type, payload) => seen.push(payload))
    reader.push(frame(0, 0, 1, 1))
    const before = Buffer.from(seen[0])
    reader.push(frame(9, 9, 2, 2))
    expect(seen[0].equals(before)).toBe(true)
  })

  it('stops rather than allocating whatever a broken length says', () => {
    const onBroken = vi.fn()
    const seen = vi.fn()
    const reader = createRecordReader(seen, onBroken)

    const nonsense = Buffer.alloc(5)
    nonsense[0] = RECORD.frame
    nonsense.writeUInt32LE(0xffffffff, 1)
    reader.push(nonsense)

    expect(reader.broken).toBe(true)
    expect(onBroken).toHaveBeenCalledOnce()
    // And nothing afterwards is believed either: the stream has lost its place.
    reader.push(frame(0, 0, 1, 1))
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('readFrame', () => {
  it('refuses a frame whose pixels do not match its size', () => {
    const head = Buffer.alloc(8)
    head.writeUInt16LE(4, 4)
    head.writeUInt16LE(4, 6)
    expect(readFrame(Buffer.concat([head, Buffer.alloc(8)]))).toBeNull()
    expect(readFrame(Buffer.alloc(4))).toBeNull()
  })
})

describe('readCursor', () => {
  it('keeps the hotspot with the image', () => {
    const head = Buffer.alloc(8)
    head.writeUInt16LE(2, 0)
    head.writeUInt16LE(2, 2)
    head.writeUInt16LE(1, 4)
    head.writeUInt16LE(1, 6)
    expect(readCursor(Buffer.concat([head, Buffer.alloc(16)]))).toMatchObject({
      width: 2,
      height: 2,
      hotX: 1,
      hotY: 1
    })
  })
})

describe('encodeCommand', () => {
  it('writes one field per line and ends with a blank one', () => {
    expect(encodeCommand({ a: 'mouse', x: 10, y: 20 })).toBe('a\tmouse\nx\t10\ny\t20\n\n')
  })

  it('escapes what would otherwise end the field or the message', () => {
    // A password is the field most likely to hold one of these, and the one
    // where a silent truncation is hardest to diagnose.
    expect(encodeCommand({ password: 'a\tb\nc\\d' })).toBe('password\ta\\tb\\nc\\\\d\n\n')
  })

  it('leaves out what was not stated, rather than sending an empty value', () => {
    expect(encodeCommand({ a: 'start', domain: undefined })).toBe('a\tstart\n\n')
  })

  it('sends a flag as the client reads it', () => {
    expect(encodeCommand({ sound: true, composition: false })).toBe('sound\t1\ncomposition\t0\n\n')
  })
})
