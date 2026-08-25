import { describe, it, expect } from 'vitest'
import {
  assertCryptoIsStandard,
  negotiate,
  parseChallenge,
  authenticate,
  rc4,
  splitIdentity
} from './ntlm'

/**
 * The worked example from [MS-NLMP] 4.2.4. Every intermediate value there is
 * published, which is the only practical way to tell a correct NTLM response
 * from one a gateway will simply call a wrong password.
 */
const SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex')
const CLIENT_CHALLENGE = Buffer.from('aaaaaaaaaaaaaaaa', 'hex')
const TARGET_INFO = Buffer.from(
  '02000c0044006f006d00610069006e00' + // NetBIOS domain "Domain"
    '01000c00530065007200760065007200' + // NetBIOS computer "Server"
    '00000000', // terminator
  'hex'
)

/** A challenge message carrying the values above, as the spec's server sends. */
function sampleChallenge(targetInfo = TARGET_INFO): Buffer {
  const header = Buffer.alloc(48)
  Buffer.from('NTLMSSP\0', 'latin1').copy(header, 0)
  header.writeUInt32LE(2, 8)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0, 14)
  header.writeUInt32LE(48, 16)
  header.writeUInt32LE(0x00808201, 20)
  SERVER_CHALLENGE.copy(header, 24)
  header.writeUInt16LE(targetInfo.length, 40)
  header.writeUInt16LE(targetInfo.length, 42)
  header.writeUInt32LE(48, 44)
  return Buffer.concat([header, targetInfo])
}

const identity = {
  username: 'User',
  domain: 'Domain',
  password: 'Password',
  workstation: 'COMPUTER'
}

describe('negotiate', () => {
  it('is a well-formed type 1 message', () => {
    const message = negotiate()
    expect(message.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0')
    expect(message.readUInt32LE(8)).toBe(1)
    expect(message).toHaveLength(32)
  })
})

describe('parseChallenge', () => {
  it('reads the server challenge and the target info', () => {
    const challenge = parseChallenge(sampleChallenge())
    expect(challenge.serverChallenge.toString('hex')).toBe('0123456789abcdef')
    expect(challenge.targetInfo.toString('hex')).toBe(TARGET_INFO.toString('hex'))
  })

  it('keeps the message verbatim, because the MIC signs it', () => {
    const raw = sampleChallenge()
    expect(parseChallenge(raw).raw.equals(raw)).toBe(true)
  })

  it('refuses anything that is not a challenge', () => {
    // No signature at all, and anything too short to hold the header.
    expect(() => parseChallenge(Buffer.alloc(48))).toThrow(/not answer with an NTLM challenge/)
    expect(() => parseChallenge(negotiate())).toThrow(/not answer with an NTLM challenge/)

    // Signed and long enough, but announcing the wrong message type.
    const wrongType = sampleChallenge()
    wrongType.writeUInt32LE(3, 8)
    expect(() => parseChallenge(wrongType)).toThrow(/Expected an NTLM challenge, got message type 3/)
  })

  it('refuses a field pointing past the end of the message', () => {
    const message = sampleChallenge()
    message.writeUInt32LE(9000, 44)
    expect(() => parseChallenge(message)).toThrow(/points past its own end/)
  })
})

describe('authenticate', () => {
  const message = authenticate(identity, parseChallenge(sampleChallenge()), {
    fixed: { clientChallenge: CLIENT_CHALLENGE, time: 0n, sessionKey: Buffer.alloc(16) }
  })

  /** Reads a length/offset field pair out of the finished message. */
  const field = (at: number): Buffer => {
    const length = message.readUInt16LE(at)
    const offset = message.readUInt32LE(at + 4)
    return message.subarray(offset, offset + length)
  }

  it('produces the NTProofStr from the specification', () => {
    // [MS-NLMP] 4.2.4.2.2. The proof is the first 16 bytes of the NT response.
    expect(field(20).subarray(0, 16).toString('hex')).toBe('68cd0ab851e51c96aabc927bebef6a1c')
  })

  it('produces the LMv2 response from the specification', () => {
    // [MS-NLMP] 4.2.4.2.1.
    expect(field(12).toString('hex')).toBe(
      '86c35097ac9cec102554764a57cccc19' + 'aaaaaaaaaaaaaaaa'
    )
  })

  it('builds temp the way the specification lays it out', () => {
    const temp = field(20).subarray(16)
    expect(temp.subarray(0, 8).toString('hex')).toBe('0101000000000000')
    expect(temp.subarray(8, 16).toString('hex')).toBe('0000000000000000')
    expect(temp.subarray(16, 24).toString('hex')).toBe('aaaaaaaaaaaaaaaa')
    expect(temp.subarray(24, 28).toString('hex')).toBe('00000000')
    // The server's own AV pairs, given back unchanged.
    expect(temp.subarray(28, 28 + TARGET_INFO.length).toString('hex')).toBe(
      TARGET_INFO.toString('hex')
    )
  })

  it('declares the version it writes', () => {
    // The eight version bytes are only meaningful if the flag says they are
    // there; written without it, a server may read them as something else.
    expect(message.readUInt32LE(60) & 0x02000000).toBe(0x02000000)
    expect(message.subarray(64, 72).toString('hex')).not.toBe('0'.repeat(16))
  })

  it('names the user and domain in the message', () => {
    expect(field(28).toString('utf16le')).toBe('Domain')
    expect(field(36).toString('utf16le')).toBe('User')
    expect(field(44).toString('utf16le')).toBe('COMPUTER')
  })

  it('leaves the MIC empty when the challenge carried no timestamp', () => {
    // Without a timestamp there is nothing to bind the messages to, and a MIC
    // the server did not ask for is one more thing that can be rejected.
    expect(message.subarray(72, 88).toString('hex')).toBe('0'.repeat(32))
  })

  it('signs the exchange when the challenge carried a timestamp', () => {
    const withTime = Buffer.concat([
      Buffer.from('0700080000000000000000 00'.replace(/ /g, ''), 'hex'),
      TARGET_INFO
    ])
    const signed = authenticate(identity, parseChallenge(sampleChallenge(withTime)), {
      fixed: { clientChallenge: CLIENT_CHALLENGE, time: 0n, sessionKey: Buffer.alloc(16) }
    })
    expect(signed.subarray(72, 88).toString('hex')).not.toBe('0'.repeat(32))
  })

  it('names the service it is signing in to, when asked', () => {
    const fixed = { clientChallenge: CLIENT_CHALLENGE, time: 0n, sessionKey: Buffer.alloc(16) }
    const named = authenticate(identity, parseChallenge(sampleChallenge()), {
      servicePrincipal: 'HTTP/gw.example.com',
      fixed
    })
    // The name goes inside the signed blob, which is what makes the response
    // usable against that service and nothing else.
    const temp = named.subarray(named.readUInt32LE(24)).subarray(16)
    expect(Buffer.from(temp).toString('utf16le')).toContain('HTTP/gw.example.com')
  })

  it('adds the channel binding when the certificate is known', () => {
    const fixed = { clientChallenge: CLIENT_CHALLENGE, time: 0n, sessionKey: Buffer.alloc(16) }
    const plain = authenticate(identity, parseChallenge(sampleChallenge()), { fixed })
    const bound = authenticate(identity, parseChallenge(sampleChallenge()), {
      channelBinding: Buffer.alloc(32, 7),
      fixed
    })
    // A different proof, because the binding is inside the signed blob — which
    // is the whole point: the response is only valid over this connection.
    expect(bound.length).toBeGreaterThan(plain.length)
    expect(bound.subarray(0, 8).toString('latin1')).toBe('NTLMSSP\0')
  })
})

describe('assertCryptoIsStandard', () => {
  it('passes on a runtime that computes the specification’s values', () => {
    expect(() => assertCryptoIsStandard()).not.toThrow()
  })
})

describe('rc4', () => {
  it('matches the RFC 6229 test vector', () => {
    const out = rc4(Buffer.from('0102030405', 'hex'), Buffer.alloc(16))
    expect(out.toString('hex')).toBe('b2396305f03dc027ccc3524a0a1118a8')
  })

  it('is its own inverse', () => {
    const key = Buffer.from('a-key')
    const data = Buffer.from('some session key')
    expect(rc4(key, rc4(key, data)).toString()).toBe('some session key')
  })
})

describe('splitIdentity', () => {
  it('splits DOMAIN\\user', () => {
    expect(splitIdentity('NSD\\pronin', 'p', 'w')).toMatchObject({
      domain: 'NSD',
      username: 'pronin'
    })
  })

  it('splits user@domain', () => {
    expect(splitIdentity('pronin@nsd.ru', 'p', 'w')).toMatchObject({
      domain: 'nsd.ru',
      username: 'pronin'
    })
  })

  it('leaves a bare name with no domain, so the gateway picks its own', () => {
    expect(splitIdentity('pronin', 'p', 'w')).toMatchObject({ domain: '', username: 'pronin' })
  })
})
