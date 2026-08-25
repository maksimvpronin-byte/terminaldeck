/**
 * The tunnel half of [MS-TSGU], the protocol a Remote Desktop Gateway speaks.
 *
 * Once the HTTP request has been upgraded, the gateway and the client exchange
 * these packets over the same socket: a handshake, a tunnel, an authorisation
 * for that tunnel, a channel to one named machine, and then the RDP bytes
 * themselves wrapped a packet at a time.
 *
 * Kept here rather than beside the socket that carries them so the whole
 * encoding can be tested without a gateway to talk to — the same reason
 * `rdcleanpath.ts` sits here. Nothing in this file does any I/O.
 */

export enum PacketType {
  HandshakeRequest = 0x1,
  HandshakeResponse = 0x2,
  ExtendedAuth = 0x3,
  TunnelCreate = 0x4,
  TunnelResponse = 0x5,
  TunnelAuth = 0x6,
  TunnelAuthResponse = 0x7,
  ChannelCreate = 0x8,
  ChannelResponse = 0x9,
  Data = 0xa,
  ServiceMessage = 0xb,
  ReauthMessage = 0xc,
  Keepalive = 0xd,
  CloseChannel = 0x10,
  CloseChannelResponse = 0x11
}

/** Type, reserved, and the length of the whole packet including this header. */
export const HEADER_LENGTH = 8

/** Capabilities this client claims. Deliberately modest — see tunnelCreate. */
const CAPABILITIES = {
  quarantineSoh: 0x1,
  idleTimeout: 0x2,
  consentSigning: 0x4,
  serviceMessage: 0x8,
  reauth: 0x10,
  udpTransport: 0x20
}

/** Fields a tunnel response may carry after its fixed part. */
const TUNNEL_RESPONSE_FIELD = {
  tunnelId: 0x1,
  capabilities: 0x2,
  sohRequest: 0x4,
  consentMessage: 0x10
}

const TUNNEL_AUTH_RESPONSE_FIELD = {
  redirectionFlags: 0x1,
  idleTimeout: 0x2,
  sohResponse: 0x4
}

const CHANNEL_RESPONSE_FIELD = {
  channelId: 0x1,
  authnCookie: 0x2,
  udpPort: 0x4
}

export interface PacketHeader {
  type: number
  length: number
}

/** Reads a header, or says how many more bytes are needed to have one. */
export function readHeader(buffer: Uint8Array): PacketHeader | null {
  if (buffer.length < HEADER_LENGTH) return null
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return { type: view.getUint16(0, true), length: view.getUint32(4, true) }
}

/**
 * Splits a stream of bytes into whole tunnel packets.
 *
 * On the WebSocket transport a packet usually fills one frame, and on the older
 * one it arrives inside HTTP chunks that are cut wherever the sender felt like
 * it. Neither boundary is the packet's, so both go through here: a packet is
 * whole when its header's length has arrived, and not before.
 */
export class PacketReader {
  private buffered = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    const grown = new Uint8Array(this.buffered.length + chunk.length)
    grown.set(this.buffered)
    grown.set(chunk, this.buffered.length)
    this.buffered = grown

    const packets: Uint8Array[] = []
    for (;;) {
      const header = readHeader(this.buffered)
      if (!header) break
      if (header.length < HEADER_LENGTH) {
        throw new Error(`The gateway sent a packet claiming to be ${header.length} bytes long`)
      }
      if (this.buffered.length < header.length) break
      packets.push(this.buffered.slice(0, header.length))
      this.buffered = this.buffered.subarray(header.length)
    }
    return packets
  }
}

function packet(type: PacketType, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + body.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, type, true)
  view.setUint16(2, 0, true)
  view.setUint32(4, out.length, true)
  out.set(body, HEADER_LENGTH)
  return out
}

/** The body of a packet, with its header taken off and its length checked. */
function body(raw: Uint8Array, type: PacketType, minimum: number): DataView {
  const header = readHeader(raw)
  if (!header) throw new Error('The gateway sent a packet with no header')
  if (header.type !== type) {
    throw new Error(
      `Expected ${nameOf(type)} from the gateway, got ${nameOf(header.type)}`
    )
  }
  if (raw.length < HEADER_LENGTH + minimum) {
    throw new Error(`The gateway's ${nameOf(type)} is ${raw.length} bytes, too short to read`)
  }
  return new DataView(raw.buffer, raw.byteOffset + HEADER_LENGTH, raw.length - HEADER_LENGTH)
}

/**
 * Message one: what version this client speaks, and how it intends to
 * authenticate. Zero means the HTTP layer has already done it, which is the
 * case here — the NTLM exchange happens in the `Authorization` header before
 * this socket carries anything.
 */
export function handshakeRequest(): Uint8Array {
  const out = new Uint8Array(6)
  const view = new DataView(out.buffer)
  view.setUint8(0, 1) // version major
  view.setUint8(1, 0) // version minor
  view.setUint16(2, 0, true) // client version, must be zero
  view.setUint16(4, 0, true) // extended authentication: none
  return packet(PacketType.HandshakeRequest, out)
}

export interface HandshakeResponse {
  errorCode: number
  serverVersion: number
  extendedAuth: number
}

export function parseHandshakeResponse(raw: Uint8Array): HandshakeResponse {
  const view = body(raw, PacketType.HandshakeResponse, 10)
  return {
    errorCode: view.getUint32(0, true),
    serverVersion: view.getUint16(6, true),
    extendedAuth: view.getUint16(8, true)
  }
}

/**
 * Message two: asks for a tunnel.
 *
 * The capabilities claimed are the ones this client can actually honour if the
 * gateway uses them. Quarantine and consent signing are claimed because a
 * gateway configured for either refuses a client that cannot say it understands
 * them, and both amount to reading a field and moving on. UDP transport is not
 * claimed: there is no second socket here to carry it.
 */
export function tunnelCreate(): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(
    0,
    CAPABILITIES.quarantineSoh | CAPABILITIES.consentSigning | CAPABILITIES.serviceMessage,
    true
  )
  view.setUint16(4, 0, true) // fields present: none, so no PAA cookie
  view.setUint16(6, 0, true) // reserved
  return packet(PacketType.TunnelCreate, out)
}

export interface TunnelResponse {
  errorCode: number
  serverVersion: number
  tunnelId?: number
  /** A message the gateway wants shown and agreed to before anything else. */
  consentMessage?: string
}

export function parseTunnelResponse(raw: Uint8Array): TunnelResponse {
  const view = body(raw, PacketType.TunnelResponse, 10)
  const serverVersion = view.getUint16(0, true)
  const errorCode = view.getUint32(2, true)
  const fields = view.getUint16(6, true)

  const response: TunnelResponse = { errorCode, serverVersion }
  let at = 10
  if (fields & TUNNEL_RESPONSE_FIELD.tunnelId) {
    response.tunnelId = view.getUint32(at, true)
    at += 4
  }
  if (fields & TUNNEL_RESPONSE_FIELD.capabilities) at += 4
  if (fields & TUNNEL_RESPONSE_FIELD.sohRequest) {
    at += 20 // nonce
    at = skipUnicodeString(view, at)
  }
  if (fields & TUNNEL_RESPONSE_FIELD.consentMessage) {
    const read = readUnicodeString(view, at)
    response.consentMessage = read.value
  }
  return response
}

/**
 * Message three: authorises the tunnel for a named client machine.
 *
 * The name is the only thing carried, and a gateway logs it. There is no field
 * for a credential here: by this point the HTTP layer has already proved who
 * is calling.
 */
export function tunnelAuth(clientName: string): Uint8Array {
  const name = unicodeString(clientName)
  const out = new Uint8Array(4 + name.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true) // fields present
  view.setUint16(2, name.length, true)
  out.set(name, 4)
  return packet(PacketType.TunnelAuth, out)
}

export interface TunnelAuthResponse {
  errorCode: number
  /** What the gateway's policy allows to be redirected, when it says. */
  redirectionFlags?: number
  idleTimeoutMinutes?: number
}

export function parseTunnelAuthResponse(raw: Uint8Array): TunnelAuthResponse {
  const view = body(raw, PacketType.TunnelAuthResponse, 8)
  const errorCode = view.getUint32(0, true)
  const fields = view.getUint16(4, true)

  const response: TunnelAuthResponse = { errorCode }
  let at = 8
  if (fields & TUNNEL_AUTH_RESPONSE_FIELD.redirectionFlags) {
    response.redirectionFlags = view.getUint32(at, true)
    at += 4
  }
  if (fields & TUNNEL_AUTH_RESPONSE_FIELD.idleTimeout) {
    response.idleTimeoutMinutes = view.getUint32(at, true)
    at += 4
  }
  return response
}

/**
 * Message four: opens a channel to one machine behind the gateway.
 *
 * Protocol 3 is RDP over TCP, which is the only thing this carries. The
 * "alternate resources" count is zero: a gateway can be given a list to try in
 * turn, and nothing here has a second address to offer.
 */
export function channelCreate(host: string, port: number): Uint8Array {
  const name = unicodeString(host)
  const out = new Uint8Array(8 + name.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, 1) // one resource
  view.setUint8(1, 0) // no alternates
  view.setUint16(2, port, true)
  view.setUint16(4, 3, true) // protocol: RDP
  view.setUint16(6, name.length, true)
  out.set(name, 8)
  return packet(PacketType.ChannelCreate, out)
}

export interface ChannelResponse {
  errorCode: number
  channelId?: number
}

export function parseChannelResponse(raw: Uint8Array): ChannelResponse {
  const view = body(raw, PacketType.ChannelResponse, 8)
  const errorCode = view.getUint32(0, true)
  const fields = view.getUint16(4, true)

  const response: ChannelResponse = { errorCode }
  if (fields & CHANNEL_RESPONSE_FIELD.channelId) response.channelId = view.getUint32(8, true)
  return response
}

/** Wraps RDP bytes for the tunnel. */
export function dataPacket(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length)
  new DataView(out.buffer).setUint16(0, payload.length, true)
  out.set(payload, 2)
  return packet(PacketType.Data, out)
}

/** Unwraps them again. */
export function parseDataPacket(raw: Uint8Array): Uint8Array {
  const view = body(raw, PacketType.Data, 2)
  const length = view.getUint16(0, true)
  if (HEADER_LENGTH + 2 + length > raw.length) {
    throw new Error('The gateway sent a data packet shorter than it claimed')
  }
  return raw.subarray(HEADER_LENGTH + 2, HEADER_LENGTH + 2 + length)
}

/** A length-prefixed UTF-16LE string, terminator included, as the tunnel wants. */
function unicodeString(value: string): Uint8Array {
  const out = new Uint8Array((value.length + 1) * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < value.length; i++) view.setUint16(i * 2, value.charCodeAt(i), true)
  return out
}

function readUnicodeString(view: DataView, at: number): { value: string; next: number } {
  const length = view.getUint16(at, true)
  let value = ''
  for (let i = 0; i < length / 2; i++) {
    const unit = view.getUint16(at + 2 + i * 2, true)
    if (unit !== 0) value += String.fromCharCode(unit)
  }
  return { value, next: at + 2 + length }
}

function skipUnicodeString(view: DataView, at: number): number {
  return readUnicodeString(view, at).next
}

/**
 * What a gateway's error code means, in words.
 *
 * These are the failures a person can act on — the wrong group, a machine that
 * is off, a policy that forbids the connection — and the numbers alone say none
 * of it. Anything unrecognised is reported as its hex code rather than swallowed.
 */
export function describeError(code: number): string {
  const known: Record<number, string> = {
    0x00000000: 'success',
    0x800759d8: 'the gateway hit an internal error',
    0x800759da: 'the gateway’s connection policy does not allow this account to reach that machine',
    0x800759db: 'the gateway’s health policy refused this computer',
    0x800759dd: 'the gateway could not reach the machine',
    0x800759df: 'the session had already been disconnected',
    0x800759e9: 'the gateway and this client disagree on capabilities',
    0x800759ed: 'the gateway requires a health check this client cannot answer',
    0x800759ee: 'the gateway has no certificate available',
    0x800759f7: 'the gateway rejected the authentication packet as malformed',
    0x800759f8: 'the gateway refused these credentials',
    0x800759f9: 'the gateway does not support the authentication method offered',
    0x000059e6: 'the gateway has reached its connection limit',
    0x000059e8: 'the gateway does not support what was asked of it',
    0x000059f6: 'the session timed out'
  }
  return known[code >>> 0] ?? `error 0x${(code >>> 0).toString(16)}`
}

/** Whether a code means the packet succeeded. Anything with bit 31 set is a failure. */
export function failed(code: number): boolean {
  return (code & 0x80000000) !== 0
}

function nameOf(type: number): string {
  const names: Record<number, string> = {
    [PacketType.HandshakeRequest]: 'a handshake request',
    [PacketType.HandshakeResponse]: 'a handshake response',
    [PacketType.ExtendedAuth]: 'an extended authentication message',
    [PacketType.TunnelCreate]: 'a tunnel request',
    [PacketType.TunnelResponse]: 'a tunnel response',
    [PacketType.TunnelAuth]: 'a tunnel authorisation',
    [PacketType.TunnelAuthResponse]: 'a tunnel authorisation response',
    [PacketType.ChannelCreate]: 'a channel request',
    [PacketType.ChannelResponse]: 'a channel response',
    [PacketType.Data]: 'data',
    [PacketType.ServiceMessage]: 'a service message',
    [PacketType.ReauthMessage]: 'a re-authentication message',
    [PacketType.Keepalive]: 'a keepalive',
    [PacketType.CloseChannel]: 'a channel close',
    [PacketType.CloseChannelResponse]: 'a channel close response'
  }
  return names[type] ?? `packet type 0x${type.toString(16)}`
}
