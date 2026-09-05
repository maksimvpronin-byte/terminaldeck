/**
 * The SOCKS5 handshake, as arithmetic on a buffer.
 *
 * TCP has no message boundaries, and this is where that was forgotten: the
 * handshake was read with two `socket.once('data')` calls, one for the greeting
 * and one for the request, each assuming that a whole message arrives in one
 * event. Nothing guarantees that. A request split across two segments left the
 * parser reading a port past the end of the buffer — a `RangeError` thrown
 * inside a socket's `data` handler, which is an uncaught exception in the main
 * process and takes every open session down with it.
 *
 * The other half of the same mistake is quieter: bytes *after* the request, in
 * the same segment, were dropped. A client that sends its first payload without
 * waiting — which is allowed, and is what a pipelining client does — lost it,
 * and the connection then hung with both ends waiting for the other.
 *
 * So parsing is separated from reading here: these functions say "not yet",
 * "malformed", or "here is the message and here is what was left over", and the
 * socket code above them does nothing but accumulate and act on the answer.
 */

/** What a parser says about the bytes it has so far. */
export type Parsed<T = object> =
  | { status: 'incomplete' }
  | { status: 'invalid'; why: string }
  | ({ status: 'ok'; rest: Buffer } & T)

/**
 * The client's greeting: version, a count, and that many method bytes. Only the
 * no-authentication method is offered in reply, which is what a local forward
 * on the loopback address needs and all it needs.
 */
export function parseGreeting(buf: Buffer): Parsed {
  if (buf.length < 2) return { status: 'incomplete' }
  if (buf[0] !== 0x05) return { status: 'invalid', why: `not SOCKS5 (version ${buf[0]})` }
  const methods = buf[1]
  const total = 2 + methods
  if (buf.length < total) return { status: 'incomplete' }
  return { status: 'ok', rest: buf.subarray(total) }
}

export interface Socks5Request {
  address: string
  port: number
}

/**
 * The connect request. Refuses everything but CONNECT, which is the only
 * command a dynamic forward implements — BIND and UDP ASSOCIATE would each need
 * a listening socket of their own on the far side.
 */
export function parseRequest(buf: Buffer): Parsed<Socks5Request> {
  // Version, command, reserved, address type: the fixed head of every request.
  if (buf.length < 4) return { status: 'incomplete' }
  if (buf[0] !== 0x05) return { status: 'invalid', why: `not SOCKS5 (version ${buf[0]})` }
  if (buf[1] !== 0x01) return { status: 'invalid', why: `unsupported command ${buf[1]}` }

  const type = buf[3]
  let address: string
  let after: number

  if (type === 0x01) {
    if (buf.length < 10) return { status: 'incomplete' }
    address = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`
    after = 8
  } else if (type === 0x03) {
    // The length byte first, and only then the name it counts — reading the
    // name before knowing it has arrived is what truncated it silently.
    if (buf.length < 5) return { status: 'incomplete' }
    const length = buf[4]
    if (buf.length < 5 + length + 2) return { status: 'incomplete' }
    address = buf.subarray(5, 5 + length).toString('ascii')
    after = 5 + length
  } else if (type === 0x04) {
    if (buf.length < 22) return { status: 'incomplete' }
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16))
    address = parts.join(':')
    after = 20
  } else {
    return { status: 'invalid', why: `unsupported address type ${type}` }
  }

  if (buf.length < after + 2) return { status: 'incomplete' }
  return {
    status: 'ok',
    address,
    port: buf.readUInt16BE(after),
    // Whatever the client sent behind the request. It belongs to the far end,
    // and dropping it is how a pipelined connection hangs.
    rest: buf.subarray(after + 2)
  }
}

/** Reply codes, from RFC 1928: the ones this end can produce. */
export const SOCKS5_GRANTED = 0x00
export const SOCKS5_FAILED = 0x05

/**
 * A reply, which is the same ten bytes whatever happened: the bound address is
 * not used by any client that only ever issues CONNECT, so zeroes are honest.
 */
export function reply(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

/**
 * The most a handshake may take before it is abandoned.
 *
 * A client that connects and says nothing held a socket for as long as the
 * application ran. Ten seconds is far longer than a local handshake needs and
 * far shorter than a session.
 */
export const HANDSHAKE_TIMEOUT = 10_000

/**
 * How many bytes of handshake to hold before giving up on it.
 *
 * A greeting is at most 257 bytes and a request at most 262. Anything that has
 * sent a kilobyte without completing either is not speaking SOCKS5, and the
 * buffer must not grow on its word.
 */
export const HANDSHAKE_LIMIT = 1024
