import { describe, expect, it } from 'vitest'
import { parseGreeting, parseRequest, reply } from './socks5'

/**
 * The parsers, fed the way TCP actually delivers: in whatever pieces it likes.
 *
 * The old reader took each message from a single `data` event, so these are the
 * cases it could not survive — a message split anywhere, and a message with the
 * client's first payload behind it.
 */

/** A CONNECT request for 10.0.0.1:22. */
const IPV4 = Buffer.from([0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16])
/** The same for "example.com":443. */
const DOMAIN = Buffer.concat([
  Buffer.from([0x05, 0x01, 0x00, 0x03, 11]),
  Buffer.from('example.com', 'ascii'),
  Buffer.from([0x01, 0xbb])
])

/**
 * Feeds a message one byte at a time, as a badly fragmented segment would.
 *
 * A plain loop rather than `Buffer.map`, which is `Uint8Array.map` and coerces
 * whatever the callback returns back into a byte — it answered with numbers.
 */
function byByte<T>(message: Buffer, parse: (buf: Buffer) => T): T[] {
  const answers: T[] = []
  for (let i = 1; i <= message.length; i++) answers.push(parse(message.subarray(0, i)))
  return answers
}

describe('the greeting', () => {
  it('waits for the methods it was promised', () => {
    const greeting = Buffer.from([0x05, 0x02, 0x00, 0x02])
    expect(parseGreeting(greeting.subarray(0, 1)).status).toBe('incomplete')
    expect(parseGreeting(greeting.subarray(0, 3)).status).toBe('incomplete')
    expect(parseGreeting(greeting)).toEqual({ status: 'ok', rest: Buffer.alloc(0) })
  })

  it('refuses anything that is not SOCKS5', () => {
    const parsed = parseGreeting(Buffer.from([0x04, 0x01]))
    expect(parsed.status).toBe('invalid')
  })

  it('hands back what followed the greeting', () => {
    const buf = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), IPV4])
    const parsed = parseGreeting(buf)
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') expect(parsed.rest).toEqual(IPV4)
  })
})

describe('the request', () => {
  it('reads an address and a port', () => {
    expect(parseRequest(IPV4)).toEqual({
      status: 'ok',
      address: '10.0.0.1',
      port: 22,
      rest: Buffer.alloc(0)
    })
  })

  it('reads a domain name and a port', () => {
    const parsed = parseRequest(DOMAIN)
    expect(parsed).toMatchObject({ status: 'ok', address: 'example.com', port: 443 })
  })

  it('reads an IPv6 address', () => {
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x04]),
      Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      Buffer.from([0x00, 0x50])
    ])
    expect(parseRequest(request)).toMatchObject({ address: '2001:db8:0:0:0:0:0:1', port: 80 })
  })

  it('says "not yet" at every split rather than reading past the end', () => {
    // The failure this replaces: a port read at an offset the buffer had not
    // reached threw a RangeError inside a socket handler, which is an uncaught
    // exception in the main process.
    for (const message of [IPV4, DOMAIN]) {
      const answers = byByte(message, parseRequest)
      expect(answers.slice(0, -1).every((a) => a.status === 'incomplete')).toBe(true)
      expect(answers[answers.length - 1].status).toBe('ok')
    }
  })

  it('keeps what the client sent behind the request', () => {
    const payload = Buffer.from('GET / HTTP/1.1\r\n', 'ascii')
    const parsed = parseRequest(Buffer.concat([IPV4, payload]))
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') expect(parsed.rest).toEqual(payload)
  })

  it('refuses a command that is not CONNECT, and an address type it cannot read', () => {
    expect(parseRequest(Buffer.from([0x05, 0x02, 0x00, 0x01])).status).toBe('invalid')
    expect(parseRequest(Buffer.from([0x05, 0x01, 0x00, 0x09])).status).toBe('invalid')
  })
})

describe('the reply', () => {
  it('is ten bytes, whatever it says', () => {
    expect(reply(0x00)).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
    expect(reply(0x05)).toHaveLength(10)
  })
})
