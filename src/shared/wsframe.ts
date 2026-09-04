/**
 * The client half of RFC 6455 framing, for the one socket that needs it.
 *
 * The `ws` package cannot be used here. A gateway answers the first request
 * with `401` and an NTLM challenge, so the upgrade has to be the *second*
 * request on a connection that is already open — and `ws` opens its own socket
 * and sends its own request, with no way to hand it one that has been
 * authenticated. What is left to do by hand is small: binary frames out, frames
 * in, and the two control frames that must be answered.
 *
 * No extensions, no fragmentation on the way out, and text frames are not
 * produced. A gateway sends none of those either.
 */

export enum Opcode {
  Continuation = 0x0,
  Text = 0x1,
  Binary = 0x2,
  Close = 0x8,
  Ping = 0x9,
  Pong = 0xa
}

export interface Frame {
  opcode: Opcode
  payload: Uint8Array
  final: boolean
}

/**
 * Frames a payload to send.
 *
 * A client MUST mask, and the mask MUST be unpredictable — a fixed one lets
 * anything sitting in the middle of a connection craft bytes that a proxy will
 * mistake for a request of its own. The mask is therefore taken from the
 * caller, which passes the platform's random source.
 */
export function encodeFrame(opcode: Opcode, payload: Uint8Array, mask: Uint8Array): Uint8Array {
  if (mask.length !== 4) throw new Error('A WebSocket mask is four bytes')

  const length = payload.length
  const lengthBytes = length < 126 ? 0 : length < 65536 ? 2 : 8
  const frame = new Uint8Array(2 + lengthBytes + 4 + length)
  const view = new DataView(frame.buffer)

  frame[0] = 0x80 | opcode // FIN, and this is the whole message
  frame[1] = 0x80 | (lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127)
  if (lengthBytes === 2) view.setUint16(2, length, false)
  if (lengthBytes === 8) view.setBigUint64(2, BigInt(length), false)

  const maskAt = 2 + lengthBytes
  frame.set(mask, maskAt)
  for (let i = 0; i < length; i++) frame[maskAt + 4 + i] = payload[i] ^ mask[i & 3]
  return frame
}

/**
 * Reassembles frames out of a stream that arrives in arbitrary pieces.
 *
 * A TCP read boundary has nothing to do with a frame boundary: one read can
 * carry half a header, and a 60 KB screen update arrives as a dozen of them.
 */
export class FrameReader {
  private buffered = new Uint8Array(0)
  /** A message being assembled out of continuation frames. */
  private partial: { opcode: Opcode; chunks: Uint8Array[] } | null = null

  /** Adds bytes and returns every whole message they completed. */
  push(chunk: Uint8Array): Frame[] {
    const grown = new Uint8Array(this.buffered.length + chunk.length)
    grown.set(this.buffered)
    grown.set(chunk, this.buffered.length)
    this.buffered = grown

    const done: Frame[] = []
    for (;;) {
      const frame = this.take()
      if (!frame) break

      // A control frame can arrive in the middle of a fragmented message and
      // must be handed over on its own rather than joined to it.
      if (frame.opcode >= Opcode.Close) {
        done.push(frame)
        continue
      }

      if (frame.opcode === Opcode.Continuation) {
        if (!this.partial) throw new Error('The gateway continued a message it never started')
        this.partial.chunks.push(frame.payload)
      } else {
        if (this.partial) throw new Error('The gateway started a message before finishing one')
        this.partial = { opcode: frame.opcode, chunks: [frame.payload] }
      }

      if (frame.final) {
        const held = this.partial
        this.partial = null
        done.push({ opcode: held.opcode, payload: join(held.chunks), final: true })
      }
    }
    return done
  }

  /** One frame, if a whole one is buffered. */
  private take(): Frame | null {
    const buffer = this.buffered
    if (buffer.length < 2) return null

    const final = (buffer[0] & 0x80) !== 0
    const opcode = (buffer[0] & 0x0f) as Opcode
    const masked = (buffer[1] & 0x80) !== 0
    const short = buffer[1] & 0x7f

    let at = 2
    let length = short
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    if (short === 126) {
      if (buffer.length < 4) return null
      length = view.getUint16(2, false)
      at = 4
    } else if (short === 127) {
      if (buffer.length < 10) return null
      const big = view.getBigUint64(2, false)
      // Nothing a gateway sends comes near this, and a length that cannot be
      // held in a Number would silently truncate.
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('A WebSocket frame is too large')
      length = Number(big)
      at = 10
    }

    // A server must not mask, but a frame that is masked still has to be read
    // correctly rather than mistaken for four bytes of payload.
    let mask: Uint8Array | null = null
    if (masked) {
      if (buffer.length < at + 4) return null
      mask = buffer.subarray(at, at + 4)
      at += 4
    }

    if (buffer.length < at + length) return null

    const payload = buffer.slice(at, at + length)
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]

    this.buffered = buffer.subarray(at + length)
    return { opcode, payload, final }
  }
}

function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** The value a server must echo back, hashed, to prove it understood the upgrade. */
export function acceptFor(key: string, sha1: (input: string) => string): string {
  return sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
}
