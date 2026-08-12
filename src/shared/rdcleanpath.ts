/**
 * RDCleanPath — the protocol IronRDP's WebAssembly client speaks to a gateway.
 *
 * The client will not connect to an RDP server directly: it is built for
 * Devolutions Gateway, and `proxyAddress` is a required parameter. So this app
 * stands up a gateway of its own, in the main process, and that gateway has to
 * answer in this dialect.
 *
 * The exchange is two messages. The client sends a request naming the
 * destination and carrying the X.224 connection PDU it wants delivered; the
 * proxy opens the connection, performs the X.224 exchange *and* the TLS
 * handshake with the RDP server, and answers with the server's certificate
 * chain. The client needs that chain because CredSSP binds the authentication
 * to the server's public key — it cannot see the certificate itself, since TLS
 * terminates at the proxy.
 *
 * ```text
 * RDCleanPathPdu ::= SEQUENCE {
 *     version             [0] INTEGER,
 *     error               [1] RDCleanPathErr        OPTIONAL,  -- proxy -> client
 *     destination         [2] UTF8String            OPTIONAL,  -- client -> proxy
 *     proxyAuth           [3] UTF8String            OPTIONAL,  -- client -> proxy
 *     serverAuth          [4] UTF8String            OPTIONAL,
 *     preconnectionBlob   [5] UTF8String            OPTIONAL,  -- client -> proxy
 *     x224ConnectionPdu   [6] OCTET STRING          OPTIONAL,
 *     serverCertChain     [7] SEQUENCE OF OCTET STRING OPTIONAL, -- proxy -> client
 *     serverAddr          [9] UTF8String            OPTIONAL   -- proxy -> client
 * }
 * ```
 *
 * Tags are context-specific and EXPLICIT, so each field is a constructed
 * wrapper around the real value. Tag 8 is absent from the definition, not
 * omitted here by mistake.
 */

/**
 * The protocol version, and not a number to guess at.
 *
 * `detect()` on the client reads the `[0]` field before anything else and
 * rejects the whole PDU unless it equals this exactly — the failure surfaces as
 * "detection failed (invalid PDU)", which says nothing about a version. It is
 * 3390, one more than the RDP port it resembles.
 */
export const RDCLEANPATH_VERSION = 3390

const SEQUENCE = 0x30
const INTEGER = 0x02
const OCTET_STRING = 0x04
const UTF8_STRING = 0x0c
/** Context-specific, constructed: what an EXPLICIT tag looks like on the wire. */
const contextTag = (n: number): number => 0xa0 | n

export interface RDCleanPathRequest {
  version: number
  destination?: string
  proxyAuth?: string
  serverAuth?: string
  preconnectionBlob?: string
  x224ConnectionPdu?: Uint8Array
}

export interface RDCleanPathResponse {
  version: number
  x224ConnectionPdu?: Uint8Array
  serverCertChain?: Uint8Array[]
  serverAddr?: string
}

// --- writing ---

/**
 * DER length: one byte below 128, otherwise a count byte with the high bit set
 * followed by that many big-endian bytes. A certificate chain runs to several
 * kilobytes, so the long form is not a corner case here.
 */
function encodeLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  const length = encodeLength(value.length)
  const out = new Uint8Array(1 + length.length + value.length)
  out[0] = tag
  out.set(length, 1)
  out.set(value, 1 + length.length)
  return out
}

function encodeInteger(value: number): Uint8Array {
  const bytes: number[] = []
  let rest = value
  do {
    bytes.unshift(rest & 0xff)
    rest >>>= 8
  } while (rest > 0)
  // A leading bit of 1 would read as negative, so DER pads with a zero byte.
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(INTEGER, Uint8Array.from(bytes))
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Wraps a value in its EXPLICIT context tag. */
const explicit = (n: number, inner: Uint8Array): Uint8Array => tlv(contextTag(n), inner)

export function encodeResponse(response: RDCleanPathResponse): Uint8Array {
  const fields: Uint8Array[] = [explicit(0, encodeInteger(response.version))]

  if (response.x224ConnectionPdu) {
    fields.push(explicit(6, tlv(OCTET_STRING, response.x224ConnectionPdu)))
  }
  if (response.serverCertChain) {
    const certs = response.serverCertChain.map((c) => tlv(OCTET_STRING, c))
    fields.push(explicit(7, tlv(SEQUENCE, concat(certs))))
  }
  if (response.serverAddr !== undefined) {
    fields.push(explicit(9, tlv(UTF8_STRING, new TextEncoder().encode(response.serverAddr))))
  }
  return tlv(SEQUENCE, concat(fields))
}

// --- reading ---

interface Element {
  tag: number
  value: Uint8Array
  /** Offset just past this element, for walking a sequence. */
  end: number
}

function readElement(buffer: Uint8Array, at: number): Element {
  if (at + 2 > buffer.length) throw new Error('Truncated DER element')
  const tag = buffer[at]
  // Multi-byte tags start 0b---11111; RDCleanPath has no field numbered high
  // enough to need one, so meeting it means this is not the PDU we expect.
  if ((tag & 0x1f) === 0x1f) throw new Error('Multi-byte DER tags are not expected here')

  let cursor = at + 1
  let length = buffer[cursor++]
  if (length & 0x80) {
    const count = length & 0x7f
    if (count === 0) throw new Error('Indefinite DER lengths are not valid in DER')
    if (count > 4) throw new Error('DER length is implausibly large')
    if (cursor + count > buffer.length) throw new Error('Truncated DER length')
    length = 0
    for (let i = 0; i < count; i++) length = length * 256 + buffer[cursor++]
  }
  if (cursor + length > buffer.length) throw new Error('DER element runs past the buffer')
  return { tag, value: buffer.subarray(cursor, cursor + length), end: cursor + length }
}

function readInteger(value: Uint8Array): number {
  let out = 0
  for (const byte of value) out = out * 256 + byte
  return out
}

const readString = (value: Uint8Array): string => new TextDecoder().decode(value)

/**
 * Reads what the client sent. Unknown fields are skipped rather than refused:
 * a newer client adding one must not stop this proxy from answering.
 */
export function decodeRequest(buffer: Uint8Array): RDCleanPathRequest {
  const outer = readElement(buffer, 0)
  if (outer.tag !== SEQUENCE) throw new Error('RDCleanPath PDU is not a SEQUENCE')

  const request: Partial<RDCleanPathRequest> = {}
  let at = 0
  while (at < outer.value.length) {
    const field = readElement(outer.value, at)
    at = field.end
    // EXPLICIT tagging: the real value sits inside the context wrapper.
    const inner = readElement(field.value, 0)

    switch (field.tag) {
      case contextTag(0):
        request.version = readInteger(inner.value)
        break
      case contextTag(2):
        request.destination = readString(inner.value)
        break
      case contextTag(3):
        request.proxyAuth = readString(inner.value)
        break
      case contextTag(4):
        request.serverAuth = readString(inner.value)
        break
      case contextTag(5):
        request.preconnectionBlob = readString(inner.value)
        break
      case contextTag(6):
        request.x224ConnectionPdu = inner.value
        break
      default:
        break
    }
  }

  if (request.version === undefined) throw new Error('RDCleanPath request states no version')
  return request as RDCleanPathRequest
}

/**
 * Whether a buffer holds a whole PDU yet.
 *
 * A WebSocket message usually arrives entire, but nothing promises it, and a
 * request carrying a preconnection blob can cross a frame boundary. Returns the
 * PDU's total length, or null while more is still needed.
 */
export function pduLength(buffer: Uint8Array): number | null {
  try {
    const element = readElement(buffer, 0)
    return element.end
  } catch {
    return null
  }
}

/**
 * The destination as host and port.
 *
 * The client sends `host:port`, and a bare host means the usual RDP port. An
 * IPv6 literal is bracketed, so the port cannot be found by splitting on the
 * last colon without checking for one.
 */
export function splitDestination(destination: string): { host: string; port: number } {
  const trimmed = destination.trim()
  if (!trimmed) throw new Error('The client named no destination')

  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']')
    if (close < 0) throw new Error(`Unbalanced IPv6 literal: ${destination}`)
    const host = trimmed.slice(1, close)
    const rest = trimmed.slice(close + 1)
    if (!rest) return { host, port: 3389 }
    if (!rest.startsWith(':')) throw new Error(`Unexpected text after the address: ${destination}`)
    return { host, port: parsePort(rest.slice(1), destination) }
  }

  const cut = trimmed.lastIndexOf(':')
  // No colon, or several — the latter being a bare IPv6 address with no port.
  if (cut < 0 || trimmed.indexOf(':') !== cut) return { host: trimmed, port: 3389 }
  return { host: trimmed.slice(0, cut), port: parsePort(trimmed.slice(cut + 1), destination) }
}

function parsePort(text: string, whole: string): number {
  const port = Number(text)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Not a port number: ${whole}`)
  }
  return port
}
