import { describe, it, expect } from 'vitest'
import {
  RDCLEANPATH_VERSION,
  decodeRequest,
  encodeResponse,
  pduLength,
  splitDestination
} from './rdcleanpath'

/** Builds a DER TLV, so the tests state bytes rather than trusting the writer. */
function tlv(tag: number, value: number[]): number[] {
  if (value.length < 0x80) return [tag, value.length, ...value]
  const len: number[] = []
  let rest = value.length
  while (rest > 0) {
    len.unshift(rest & 0xff)
    rest >>>= 8
  }
  return [tag, 0x80 | len.length, ...len, ...value]
}

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)]

/** A request as the client sends one: version, destination, and the X.224 PDU. */
function clientRequest(
  destination = 'server:3389',
  x224: number[] = [3, 0, 0, 19],
  extra: number[] = []
): Uint8Array {
  const body = [
    ...tlv(0xa0, tlv(0x02, [0x0d, 0x3e])), // [0] INTEGER 3390
    ...tlv(0xa2, tlv(0x0c, utf8(destination))), // [2] destination
    ...tlv(0xa6, tlv(0x04, x224)), // [6] x224ConnectionPdu
    ...extra
  ]
  return Uint8Array.from(tlv(0x30, body))
}

describe('the protocol version', () => {
  it('is 3390, which the client checks before reading anything else', () => {
    // Pinned deliberately. `detect()` on the client compares this field first
    // and rejects the whole PDU on a mismatch, reporting only "detection failed
    // (invalid PDU)" — which points at the framing rather than at the number.
    // It was 3389 here for a while, borrowed from the RDP port, and every
    // session failed with that message.
    expect(RDCLEANPATH_VERSION).toBe(3390)
  })
})

describe('decodeRequest', () => {
  it('reads what the client actually sends', () => {
    const request = decodeRequest(clientRequest())
    expect(request.version).toBe(RDCLEANPATH_VERSION)
    expect(request.destination).toBe('server:3389')
    expect([...request.x224ConnectionPdu!]).toEqual([3, 0, 0, 19])
  })

  it('reads the token and the preconnection blob when they are there', () => {
    const extra = [
      ...tlv(0xa3, tlv(0x0c, utf8('jwt-goes-here'))),
      ...tlv(0xa5, tlv(0x0c, utf8('vm-id')))
    ]
    const request = decodeRequest(clientRequest('h:1', [1], extra))
    expect(request.proxyAuth).toBe('jwt-goes-here')
    expect(request.preconnectionBlob).toBe('vm-id')
  })

  it('skips a field it does not know instead of refusing the PDU', () => {
    // A newer client adding a field must not stop this proxy answering.
    const extra = tlv(0xab, tlv(0x0c, utf8('from the future')))
    expect(() => decodeRequest(clientRequest('h:1', [1], extra))).not.toThrow()
  })

  it('refuses a PDU that states no version', () => {
    const body = tlv(0xa2, tlv(0x0c, utf8('server')))
    expect(() => decodeRequest(Uint8Array.from(tlv(0x30, body)))).toThrow(/version/i)
  })

  it('refuses something that is not a SEQUENCE', () => {
    expect(() => decodeRequest(Uint8Array.from(tlv(0x04, [1, 2, 3])))).toThrow(/SEQUENCE/i)
  })

  it('refuses a truncated PDU rather than reading past it', () => {
    const whole = clientRequest()
    expect(() => decodeRequest(whole.subarray(0, whole.length - 4))).toThrow(/past the buffer/i)
  })

  it('reads a long-form length, which any real request uses', () => {
    // A 200-byte X.224 PDU pushes the outer SEQUENCE past 127 bytes.
    const request = decodeRequest(clientRequest('h:1', new Array(200).fill(7)))
    expect(request.x224ConnectionPdu).toHaveLength(200)
  })
})

describe('encodeResponse', () => {
  it('round-trips through the reader, tag for tag', () => {
    const encoded = encodeResponse({
      version: RDCLEANPATH_VERSION,
      x224ConnectionPdu: Uint8Array.of(3, 0, 0, 19, 14),
      serverCertChain: [Uint8Array.of(0x30, 0x82), Uint8Array.of(0x30, 0x81)],
      serverAddr: '10.0.0.5:3389'
    })

    // Read it back with the request reader, which shares the DER walker.
    const outer = decodeRequest(encoded)
    expect(outer.version).toBe(RDCLEANPATH_VERSION)
    expect([...outer.x224ConnectionPdu!]).toEqual([3, 0, 0, 19, 14])
  })

  it('starts with a SEQUENCE and carries the version first', () => {
    const encoded = encodeResponse({ version: RDCLEANPATH_VERSION })
    expect(encoded[0]).toBe(0x30)
    // [0] EXPLICIT INTEGER 3390 => A0 04 02 02 0D 3E
    expect([...encoded.subarray(2, 8)]).toEqual([0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e])
  })

  it('nests the certificate chain as a SEQUENCE OF OCTET STRING', () => {
    const encoded = encodeResponse({
      version: 1,
      serverCertChain: [Uint8Array.of(0xaa), Uint8Array.of(0xbb)]
    })
    // A7 <len> 30 <len> 04 01 AA 04 01 BB
    const at = encoded.indexOf(0xa7)
    expect(at).toBeGreaterThan(0)
    expect([...encoded.subarray(at, at + 10)]).toEqual([
      0xa7, 0x08, 0x30, 0x06, 0x04, 0x01, 0xaa, 0x04, 0x01, 0xbb
    ])
  })

  it('uses the long form once a certificate chain makes it necessary', () => {
    // A real chain is kilobytes; getting the length form wrong there and not
    // here would be a bug nothing small could catch.
    const cert = new Uint8Array(1000).fill(0x41)
    const encoded = encodeResponse({ version: 1, serverCertChain: [cert] })
    expect(encoded[0]).toBe(0x30)
    expect(encoded[1] & 0x80).toBeTruthy()
    expect(pduLength(encoded)).toBe(encoded.length)
  })

  it('leaves out what it was not given', () => {
    const encoded = encodeResponse({ version: 1 })
    expect(encoded).not.toContain(0xa7)
    expect(encoded).not.toContain(0xa9)
  })
})

describe('pduLength', () => {
  it('reports the whole length once the PDU has arrived', () => {
    const whole = clientRequest()
    expect(pduLength(whole)).toBe(whole.length)
  })

  it('says nothing yet while the buffer is still short', () => {
    // A request can cross a frame boundary, and reading it early would fail in
    // a way that looks like a malformed client rather than a partial read.
    const whole = clientRequest('h:1', new Array(300).fill(9))
    expect(pduLength(whole.subarray(0, 20))).toBeNull()
  })

  it('reports the length even when more has already arrived behind it', () => {
    const whole = clientRequest()
    const withTrailer = new Uint8Array(whole.length + 5)
    withTrailer.set(whole)
    expect(pduLength(withTrailer)).toBe(whole.length)
  })
})

describe('splitDestination', () => {
  it('splits host and port', () => {
    expect(splitDestination('10.0.0.5:3389')).toEqual({ host: '10.0.0.5', port: 3389 })
  })

  it('defaults the port when the client sent a bare host', () => {
    expect(splitDestination('win-dc')).toEqual({ host: 'win-dc', port: 3389 })
  })

  it('does not mistake an IPv6 address for a host and port', () => {
    expect(splitDestination('2001:db8::1')).toEqual({ host: '2001:db8::1', port: 3389 })
  })

  it('reads a bracketed IPv6 literal with a port', () => {
    expect(splitDestination('[2001:db8::1]:3390')).toEqual({ host: '2001:db8::1', port: 3390 })
  })

  it('reads a bracketed IPv6 literal without one', () => {
    expect(splitDestination('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 3389 })
  })

  it('refuses a port that is not a number', () => {
    expect(() => splitDestination('host:rdp')).toThrow(/port/i)
  })

  it('refuses an empty destination', () => {
    expect(() => splitDestination('  ')).toThrow(/no destination/i)
  })
})
