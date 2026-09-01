/**
 * Cuts the desktop client's output back into the records it wrote.
 *
 * A pipe carries bytes, not messages: one write of a frame arrives as four
 * reads, and two small events arrive as one. So every record states its length
 * and this reassembles them — the same job the SSH side does for terminal
 * output, with the difference that a frame here is megabytes and must not be
 * copied more times than it has to be.
 *
 * Kept apart from the process that produces it so it can be tested by handing
 * it bytes, including the cruel splits: a length cut in half, a header alone,
 * a chunk holding the end of one record and the start of two more.
 */

/** The first byte of a record. Mirrors td_proto.h, and must stay in step. */
export const RECORD = {
  event: 1,
  frame: 2,
  cursor: 3,
  cursorState: 4
} as const

const HEADER = 5

/**
 * The largest record worth believing: a 4K desktop, in full, plus its header.
 *
 * Not a tuning knob — a sanity check. A length read out of a desynchronised
 * stream is an arbitrary number, and acting on it means allocating whatever it
 * happens to say. Stopping is the only safe answer, because a stream that has
 * lost its place never finds it again.
 */
const LIMIT = 3840 * 2160 * 4 + 64

export type OnRecord = (type: number, payload: Buffer) => void

export interface RecordReader {
  /** Feeds one chunk; calls back once per whole record inside it. */
  push(chunk: Buffer): void
  /** True once a length arrived that cannot be right; nothing more is read. */
  readonly broken: boolean
}

export function createRecordReader(onRecord: OnRecord, onBroken?: (why: string) => void): RecordReader {
  /**
   * What has arrived and not yet been used, kept as the chunks it arrived in.
   *
   * The obvious version of this concatenates each chunk onto one growing
   * buffer, and that is what it did. It is fine for a terminal, where a message
   * is a line — and quadratic for a desktop, where a message is a frame: a
   * 4K frame is 29 MB and reaches this in something like four hundred pieces,
   * so each arrival copied the whole of what came before. Six gigabytes of
   * memcpy per frame, which is what a scroll felt like.
   *
   * Held as a list, the same frame is copied exactly once — when it is whole
   * and about to be handed on.
   */
  let chunks: Buffer[] = []
  let held = 0
  let broken = false

  /** The first `n` bytes, without consuming them. Only ever the header. */
  function peek(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    for (const chunk of chunks) {
      const want = Math.min(chunk.length, n - filled)
      chunk.copy(out, filled, 0, want)
      filled += want
      if (filled === n) break
    }
    return out
  }

  /** Takes the first `n` bytes, copying them once and dropping what is spent. */
  function take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const chunk = chunks[0]
      const want = Math.min(chunk.length, n - filled)
      chunk.copy(out, filled, 0, want)
      filled += want
      if (want === chunk.length) chunks.shift()
      else chunks[0] = chunk.subarray(want)
    }
    held -= n
    return out
  }

  return {
    get broken() {
      return broken
    },

    push(chunk: Buffer): void {
      if (broken || chunk.length === 0) return
      chunks.push(chunk)
      held += chunk.length

      for (;;) {
        if (held < HEADER) return
        const header = peek(HEADER)
        const type = header[0]
        const length = header.readUInt32LE(1)

        if (length > LIMIT) {
          broken = true
          chunks = []
          held = 0
          onBroken?.(`a record claiming ${length} bytes, which cannot be right`)
          return
        }
        if (held < HEADER + length) return

        take(HEADER)
        // Its own memory, so nothing that arrives later can change it under
        // whoever is drawing it.
        onRecord(type, take(length))
      }
    }
  }
}

/** A frame record's own header: where it goes, and how big it is. */
export interface FramePlace {
  x: number
  y: number
  width: number
  height: number
  /** The pixels themselves, RGBA, top row first. */
  pixels: Buffer
}

/**
 * Reads a frame record, or nothing if it is not one.
 *
 * The check is not ceremony: a truncated frame handed to a canvas is a crash
 * in the renderer rather than a missed update here.
 */
export function readFrame(payload: Buffer): FramePlace | null {
  if (payload.length < 8) return null
  const x = payload.readUInt16LE(0)
  const y = payload.readUInt16LE(2)
  const width = payload.readUInt16LE(4)
  const height = payload.readUInt16LE(6)
  const pixels = payload.subarray(8)
  if (width === 0 || height === 0) return null
  if (pixels.length !== width * height * 4) return null
  return { x, y, width, height, pixels }
}

/** A cursor record: the same, with the hotspot where the position would be. */
export interface CursorImage {
  width: number
  height: number
  hotX: number
  hotY: number
  pixels: Buffer
}

export function readCursor(payload: Buffer): CursorImage | null {
  if (payload.length < 8) return null
  const width = payload.readUInt16LE(0)
  const height = payload.readUInt16LE(2)
  const hotX = payload.readUInt16LE(4)
  const hotY = payload.readUInt16LE(6)
  const pixels = payload.subarray(8)
  if (width === 0 || height === 0) return null
  if (pixels.length !== width * height * 4) return null
  return { width, height, hotX, hotY, pixels }
}

/**
 * One message down the pipe, in the form the client reads.
 *
 * Tab-separated, one field per line, a blank line ending it — chosen for the
 * side that has to parse it, which is written in C. Three characters have to
 * be escaped because three are structural, and a password is exactly the field
 * most likely to contain them.
 */
export function encodeCommand(fields: Record<string, string | number | boolean | undefined>): string {
  let out = ''
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text =
      typeof value === 'boolean' ? (value ? '1' : '0') : typeof value === 'number' ? String(value) : value
    out += `${key}\t${text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}\n`
  }
  return `${out}\n`
}
