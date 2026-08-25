import { describe, it, expect } from 'vitest'
import {
  HEADER_LENGTH,
  PacketType,
  channelCreate,
  dataPacket,
  describeError,
  failed,
  handshakeRequest,
  PacketReader,
  parseChannelResponse,
  parseDataPacket,
  parseHandshakeResponse,
  parseTunnelAuthResponse,
  parseTunnelResponse,
  readHeader,
  tunnelAuth,
  tunnelCreate
} from './tsgu'

/** Builds a packet the way a gateway would, to read back. */
function fromGateway(type: PacketType, body: number[]): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + body.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, type, true)
  view.setUint32(4, out.length, true)
  out.set(body, HEADER_LENGTH)
  return out
}

const le32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff
]
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff]

describe('packet headers', () => {
  it('states the type and the whole length, this header included', () => {
    const packet = handshakeRequest()
    expect(readHeader(packet)).toEqual({ type: PacketType.HandshakeRequest, length: 14 })
    expect(packet).toHaveLength(14)
  })

  it('says nothing until a whole header has arrived', () => {
    expect(readHeader(new Uint8Array(7))).toBeNull()
  })

  it('names what it got when the gateway answers with the wrong packet', () => {
    const wrong = fromGateway(PacketType.TunnelResponse, new Array(10).fill(0))
    expect(() => parseHandshakeResponse(wrong)).toThrow(
      /Expected a handshake response from the gateway, got a tunnel response/
    )
  })

  it('refuses a packet too short for the fields it must hold', () => {
    const stub = fromGateway(PacketType.HandshakeResponse, [0, 0])
    expect(() => parseHandshakeResponse(stub)).toThrow(/too short to read/)
  })
})

describe('handshake', () => {
  it('asks for version 1.0 and no extended authentication', () => {
    const packet = handshakeRequest()
    expect(packet[8]).toBe(1)
    expect(packet[9]).toBe(0)
    // Extended authentication stays zero: NTLM has already happened over HTTP.
    expect(packet[12]).toBe(0)
    expect(packet[13]).toBe(0)
  })

  it('reads the response', () => {
    const raw = fromGateway(PacketType.HandshakeResponse, [
      ...le32(0),
      1,
      0,
      ...le16(0x0006),
      ...le16(0)
    ])
    expect(parseHandshakeResponse(raw)).toEqual({
      errorCode: 0,
      serverVersion: 6,
      extendedAuth: 0
    })
  })
})

describe('tunnel', () => {
  it('claims only capabilities this client can honour', () => {
    const packet = tunnelCreate()
    const caps = new DataView(packet.buffer).getUint32(HEADER_LENGTH, true)
    expect(caps & 0x20).toBe(0) // no UDP transport: there is no socket for it
    expect(caps & 0x1).toBe(0x1) // quarantine, which is only read and passed over
  })

  it('reads a response with no optional fields', () => {
    const raw = fromGateway(PacketType.TunnelResponse, [
      ...le16(6),
      ...le32(0),
      ...le16(0),
      ...le16(0)
    ])
    expect(parseTunnelResponse(raw)).toEqual({ errorCode: 0, serverVersion: 6 })
  })

  it('reads the tunnel id when the gateway sends one', () => {
    const raw = fromGateway(PacketType.TunnelResponse, [
      ...le16(6),
      ...le32(0),
      ...le16(0x1),
      ...le16(0),
      ...le32(0x2a)
    ])
    expect(parseTunnelResponse(raw).tunnelId).toBe(0x2a)
  })

  it('reads a consent message past the fields before it', () => {
    const text = 'Read this'
    const encoded: number[] = []
    for (const ch of text + '\0') encoded.push(...le16(ch.charCodeAt(0)))
    const raw = fromGateway(PacketType.TunnelResponse, [
      ...le16(6),
      ...le32(0),
      ...le16(0x1 | 0x2 | 0x10), // tunnel id, capabilities, then the message
      ...le16(0),
      ...le32(7),
      ...le32(0),
      ...le16(encoded.length),
      ...encoded
    ])
    expect(parseTunnelResponse(raw).consentMessage).toBe(text)
  })

  it('names the client machine in the authorisation, terminator included', () => {
    const packet = tunnelAuth('mac')
    const length = new DataView(packet.buffer).getUint16(HEADER_LENGTH + 2, true)
    expect(length).toBe(8) // four UTF-16 units: m, a, c and the terminator
    expect(packet).toHaveLength(HEADER_LENGTH + 4 + 8)
  })

  it('reads the redirection policy out of the authorisation response', () => {
    const raw = fromGateway(PacketType.TunnelAuthResponse, [
      ...le32(0),
      ...le16(0x1 | 0x2),
      ...le16(0),
      ...le32(0x80000000),
      ...le32(30)
    ])
    expect(parseTunnelAuthResponse(raw)).toEqual({
      errorCode: 0,
      redirectionFlags: 0x80000000,
      idleTimeoutMinutes: 30
    })
  })
})

describe('channel', () => {
  it('asks for one RDP resource on the stated port', () => {
    const packet = channelCreate('pc.example.com', 3389)
    const view = new DataView(packet.buffer)
    expect(packet[HEADER_LENGTH]).toBe(1) // one resource
    expect(packet[HEADER_LENGTH + 1]).toBe(0) // no alternates
    expect(view.getUint16(HEADER_LENGTH + 2, true)).toBe(3389)
    expect(view.getUint16(HEADER_LENGTH + 4, true)).toBe(3) // protocol RDP
    const name = packet.subarray(HEADER_LENGTH + 8)
    expect(Buffer.from(name).toString('utf16le')).toBe('pc.example.com\0')
  })

  it('reads the channel id', () => {
    const raw = fromGateway(PacketType.ChannelResponse, [
      ...le32(0),
      ...le16(0x1),
      ...le16(0),
      ...le32(9)
    ])
    expect(parseChannelResponse(raw)).toEqual({ errorCode: 0, channelId: 9 })
  })
})

describe('data', () => {
  it('wraps and unwraps a payload', () => {
    const payload = new Uint8Array([3, 0, 0, 19, 14, 224, 0, 0])
    const wrapped = dataPacket(payload)
    expect(readHeader(wrapped)).toEqual({ type: PacketType.Data, length: 18 })
    expect(Array.from(parseDataPacket(wrapped))).toEqual(Array.from(payload))
  })

  it('survives an empty payload', () => {
    expect(parseDataPacket(dataPacket(new Uint8Array(0)))).toHaveLength(0)
  })

  it('refuses a packet claiming more data than it carries', () => {
    const wrapped = dataPacket(new Uint8Array([1, 2, 3]))
    new DataView(wrapped.buffer).setUint16(HEADER_LENGTH, 999, true)
    expect(() => parseDataPacket(wrapped)).toThrow(/shorter than it claimed/)
  })
})

describe('PacketReader', () => {
  it('returns a packet that arrives whole', () => {
    expect(new PacketReader().push(handshakeRequest())).toHaveLength(1)
  })

  it('waits for a packet split across reads', () => {
    const reader = new PacketReader()
    const packet = handshakeRequest()
    // The header itself cut in half, which a chunk boundary happily does.
    expect(reader.push(packet.subarray(0, 3))).toHaveLength(0)
    expect(reader.push(packet.subarray(3, 9))).toHaveLength(0)
    expect(reader.push(packet.subarray(9))).toHaveLength(1)
  })

  it('returns several packets that arrive together', () => {
    const both = new Uint8Array([...handshakeRequest(), ...tunnelCreate()])
    const packets = new PacketReader().push(both)
    expect(packets.map((p) => readHeader(p)!.type)).toEqual([
      PacketType.HandshakeRequest,
      PacketType.TunnelCreate
    ])
  })

  it('keeps the remainder of a read for the next packet', () => {
    const reader = new PacketReader()
    const first = handshakeRequest()
    const second = tunnelCreate()
    const cut = new Uint8Array([...first, ...second.subarray(0, 4)])
    expect(reader.push(cut)).toHaveLength(1)
    expect(reader.push(second.subarray(4))).toHaveLength(1)
  })

  it('refuses a length that cannot include its own header', () => {
    const broken = handshakeRequest()
    new DataView(broken.buffer).setUint32(4, 3, true)
    expect(() => new PacketReader().push(broken)).toThrow(/claiming to be 3 bytes/)
  })
})

describe('errors', () => {
  it('treats the high bit as failure', () => {
    expect(failed(0)).toBe(false)
    expect(failed(0x800759da)).toBe(true)
    // A "success with information" code is not a failure.
    expect(failed(0x000059f6)).toBe(false)
  })

  it('explains the failures a person can act on', () => {
    expect(describeError(0x800759da)).toMatch(/connection policy/)
    expect(describeError(0x800759dd)).toMatch(/could not reach the machine/)
    expect(describeError(0x800759f8)).toMatch(/refused these credentials/)
  })

  it('reports an unknown code rather than swallowing it', () => {
    expect(describeError(0x8badf00d)).toBe('error 0x8badf00d')
  })
})
