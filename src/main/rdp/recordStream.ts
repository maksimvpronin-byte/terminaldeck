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
   * What has arrived and not yet been used.
   *
   * Concatenated rather than kept as a list of chunks: the record being
   * assembled is usually the only thing here, and the arithmetic for reading a
   * length that straddles two chunks is the kind that is wrong for months.
   */
  // Annotated rather than inferred: `Buffer.alloc` promises the narrower
  // `Buffer<ArrayBuffer>`, while a chunk off a pipe is only `ArrayBufferLike`,
  // and concatenating the two is what the compiler objects to.
  let held: Buffer = Buffer.alloc(0)
  let broken = false

  return {
    get broken() {
      return broken
    },

    push(chunk: Buffer): void {
      if (broken) return
      held = held.length === 0 ? chunk : Buffer.concat([held, chunk])

      for (;;) {
        if (held.length < HEADER) return
        const type = held[0]
        const length = held.readUInt32LE(1)

        if (length > LIMIT) {
          broken = true
          held = Buffer.alloc(0)
          onBroken?.(`a record claiming ${length} bytes, which cannot be right`)
          return
        }
        if (held.length < HEADER + length) return

        /**
         * A view, not a copy, and then copied once.
         *
         * `subarray` shares memory with everything else still held, so a frame
         * handed on as a view would keep the whole buffer alive and would
         * change under the caller when the next chunk is concatenated in.
         */
        onRecord(type, Buffer.from(held.subarray(HEADER, HEADER + length)))
        held = held.subarray(HEADER + length)
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
