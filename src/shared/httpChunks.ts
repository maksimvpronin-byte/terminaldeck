/**
 * HTTP chunked transfer encoding, the little of it a gateway tunnel needs.
 *
 * The older RD Gateway transport does not upgrade to anything: the response to
 * `RDG_OUT_DATA` simply never ends, and the tunnel's packets arrive inside it
 * as chunks. In the other direction the request body never ends either, and
 * each packet the client sends is one chunk of it.
 *
 * Node's own HTTP client cannot be used for this. It is built to deliver a
 * response, and this one has no end; and the request body has to be written a
 * chunk at a time, interleaved with reads on a different connection, for as
 * long as the desktop is open.
 */

/** Wraps a payload as one chunk: its length in hex, the bytes, and a break. */
export function encodeChunk(payload: Uint8Array): Uint8Array {
  const header = Buffer.from(`${payload.length.toString(16)}\r\n`, 'latin1')
  const out = new Uint8Array(header.length + payload.length + 2)
  out.set(header, 0)
  out.set(payload, header.length)
  out.set([0x0d, 0x0a], header.length + payload.length)
  return out
}

/**
 * Pulls payloads back out of a chunked stream that arrives in arbitrary pieces.
 *
 * A chunk boundary has nothing to do with a read boundary, and a chunk header
 * can be split across two reads as easily as a payload can.
 */
export class ChunkReader {
  private buffered = new Uint8Array(0)
  /** How much of the current chunk's payload is still to come. */
  private remaining = 0
  /** Whether the two bytes closing the current chunk are still to come. */
  private closing = false
  private ended = false

  /** Adds bytes and returns whatever payload they completed. */
  push(chunk: Uint8Array): Uint8Array[] {
    const grown = new Uint8Array(this.buffered.length + chunk.length)
    grown.set(this.buffered)
    grown.set(chunk, this.buffered.length)
    this.buffered = grown

    const out: Uint8Array[] = []
    for (;;) {
      if (this.ended) break

      if (this.closing) {
        if (this.buffered.length < 2) break
        this.buffered = this.buffered.subarray(2)
        this.closing = false
        continue
      }

      if (this.remaining > 0) {
        if (this.buffered.length === 0) break
        const take = Math.min(this.remaining, this.buffered.length)
        out.push(this.buffered.slice(0, take))
        this.buffered = this.buffered.subarray(take)
        this.remaining -= take
        if (this.remaining === 0) this.closing = true
        continue
      }

      const header = this.readHeader()
      if (header === null) break
      if (header === 0) {
        // The terminating chunk. Anything after it is a trailer, and a tunnel
        // that has reached this point is over anyway.
        this.ended = true
        break
      }
      this.remaining = header
    }
    return out
  }

  get finished(): boolean {
    return this.ended
  }

  /** The chunk size line, or null while it is incomplete. */
  private readHeader(): number | null {
    const end = indexOfCrLf(this.buffered)
    if (end < 0) {
      // A size line is short; anything long is a stream that is not chunked.
      if (this.buffered.length > 64) throw new Error('The gateway sent a malformed chunk header')
      return null
    }
    const line = Buffer.from(this.buffered.subarray(0, end)).toString('latin1')
    // A chunk may carry extensions after a semicolon, which are not ours to read.
    const size = Number.parseInt(line.split(';')[0].trim(), 16)
    if (Number.isNaN(size) || size < 0) {
      throw new Error(`The gateway sent a chunk size this is not: "${line}"`)
    }
    this.buffered = this.buffered.subarray(end + 2)
    return size
  }
}

function indexOfCrLf(buffer: Uint8Array): number {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a) return i
  }
  return -1
}
