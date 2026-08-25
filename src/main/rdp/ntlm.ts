import { createHash, createHmac, randomBytes } from 'crypto'
import { md4 } from './md4'

/**
 * NTLMv2, enough of it to sign in to an HTTP endpoint.
 *
 * An RD Gateway answers the first request with `401` and a `WWW-Authenticate`
 * header, and expects the three-message exchange of [MS-NLMP] carried in
 * `Authorization` headers as base64. No library here does that, and the pieces
 * it needs — MD4 for the password hash, RC4 for the session key — are both gone
 * from Node's crypto under OpenSSL 3, so this is written out.
 *
 * Only the client half, and only what a gateway asks for: no signing or sealing
 * of a session afterwards, because the tunnel that follows runs over TLS and
 * never uses the NTLM session key for anything.
 */

const SIGNATURE = Buffer.from('NTLMSSP\0', 'latin1')

enum Flag {
  UNICODE = 0x00000001,
  VERSION = 0x02000000,
  REQUEST_TARGET = 0x00000004,
  NTLM = 0x00000200,
  ALWAYS_SIGN = 0x00008000,
  EXTENDED_SESSION_SECURITY = 0x00080000,
  TARGET_INFO = 0x00800000,
  KEY_EXCHANGE = 0x40000000,
  KEY_128 = 0x20000000,
  KEY_56 = 0x80000000
}

/** Attribute ids inside a challenge's target info. */
enum Av {
  EOL = 0x0000,
  TIMESTAMP = 0x0007,
  FLAGS = 0x0006,
  TARGET_NAME = 0x0009,
  CHANNEL_BINDINGS = 0x000a
}

/** Set in MsvAvFlags to say the authenticate message carries a MIC. */
const AV_FLAG_MIC = 0x00000002

/**
 * What this client offers, and then confirms.
 *
 * `>>> 0` because bit 31 is one of them: the or-expression is a signed 32-bit
 * value in JavaScript and comes out negative, which `writeUInt32LE` rejects.
 */
const NEGOTIATE_FLAGS =
  (Flag.UNICODE |
    Flag.REQUEST_TARGET |
    Flag.NTLM |
    Flag.ALWAYS_SIGN |
    Flag.EXTENDED_SESSION_SECURITY |
    Flag.KEY_EXCHANGE |
    Flag.KEY_128 |
    Flag.KEY_56) >>>
  0

/**
 * The same, plus the flags the third message adds: target info is being echoed
 * back, and a version field is present.
 *
 * The version must be declared, not merely written. A message carrying the
 * eight version bytes without the flag that says so is inconsistent, and a
 * server is entitled to read the field as something else — which fails as a
 * malformed message rather than as a refused password.
 */
const AUTHENTICATE_FLAGS = (NEGOTIATE_FLAGS | Flag.TARGET_INFO | Flag.VERSION) >>> 0

export interface Challenge {
  flags: number
  serverChallenge: Buffer
  /** The AV pairs, kept whole: they go back verbatim inside the response. */
  targetInfo: Buffer
  targetName: string
  /**
   * The message exactly as it arrived. The MIC signs all three messages, so the
   * challenge has to survive parsing byte for byte — and it travels on the
   * parsed object rather than in a module variable, or two sessions opening at
   * once would sign each other's challenge.
   */
  raw: Buffer
}

export interface Identity {
  /** Either `user`, `DOMAIN\\user` or `user@domain` — split by the caller. */
  username: string
  domain: string
  password: string
  workstation: string
}

/**
 * The first message. Announces what the client can do and nothing else — no
 * name is offered, because the gateway has not yet said which domain it wants.
 */
export function negotiate(): Buffer {
  const message = Buffer.alloc(32)
  SIGNATURE.copy(message, 0)
  message.writeUInt32LE(1, 8)
  // Unsigned: NTLMSSP_NEGOTIATE_56 is bit 31, and the bitwise-or that sets it
  // yields a negative number in JavaScript, which writeUInt32LE refuses.
  message.writeUInt32LE(NEGOTIATE_FLAGS, 12)
  // Domain and workstation fields, both empty: length, capacity and an offset
  // pointing just past the header, which is where the payload would start.
  message.writeUInt32LE(0, 16)
  message.writeUInt32LE(32, 20)
  message.writeUInt32LE(0, 24)
  message.writeUInt32LE(32, 28)
  return message
}

/** Reads the server's challenge, including the target info it must be given back. */
export function parseChallenge(message: Buffer): Challenge {
  if (message.length < 48 || !message.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('The gateway did not answer with an NTLM challenge')
  }
  if (message.readUInt32LE(8) !== 2) {
    throw new Error(`Expected an NTLM challenge, got message type ${message.readUInt32LE(8)}`)
  }

  const targetName = readField(message, 12)
  const flags = message.readUInt32LE(20)
  const serverChallenge = message.subarray(24, 32)
  const targetInfo = readField(message, 40)

  return {
    flags,
    serverChallenge: Buffer.from(serverChallenge),
    targetInfo,
    targetName: targetName.toString('utf16le'),
    raw: Buffer.from(message)
  }
}

/**
 * The third message, which carries the proof.
 *
 * `channelBinding` is the hash of the gateway's own certificate, as
 * `tls-server-end-point`. A gateway with Extended Protection turned on rejects
 * a response that does not name the channel it arrived over, and the refusal
 * looks exactly like a wrong password — so it is computed whenever the caller
 * can supply the certificate rather than only when something demands it.
 */
export interface AuthenticateOptions {
  /**
   * A hash of the server's certificate, as `tls-server-end-point`.
   *
   * A gateway with Extended Protection turned on refuses a sign-in that does
   * not name the connection it arrived over, and the refusal is a plain "access
   * denied" — indistinguishable from a wrong password.
   */
  channelBinding?: Buffer
  /**
   * The service being signed in to, as `HTTP/host`.
   *
   * Extended Protection has two halves and the channel binding is only one of
   * them. The other is service binding: the response names the service it was
   * built for, so one captured on the way to a machine cannot be replayed at
   * another. A gateway that requires it accepts the message as well formed,
   * validates the password — and only then refuses, which is why its absence is
   * invisible until the password is right.
   */
  servicePrincipal?: string
  /**
   * Leave out the message signature even where the challenge asks for one.
   *
   * Never right by the specification, and kept only because a server that
   * dislikes the signature refuses in a way that looks like everything else
   * — see the variants in TsGateway.
   */
  omitMic?: boolean
  /** Overridable so the tests can pin what is otherwise random or the clock. */
  fixed?: { clientChallenge?: Buffer; time?: bigint; sessionKey?: Buffer }
}

export function authenticate(
  identity: Identity,
  challenge: Challenge,
  options: AuthenticateOptions = {}
): Buffer {
  const { channelBinding, servicePrincipal, omitMic, fixed } = options
  const clientChallenge = fixed?.clientChallenge ?? randomBytes(8)
  const responseKey = ntowfv2(identity)

  const targetInfo = withExtras(challenge.targetInfo, channelBinding, servicePrincipal, !omitMic)
  const time = fixed?.time ?? windowsTime()

  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    le64(time),
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4)
  ])
  const proof = hmacMd5(responseKey, Buffer.concat([challenge.serverChallenge, temp]))
  const ntResponse = Buffer.concat([proof, temp])
  const lmResponse = Buffer.concat([
    hmacMd5(responseKey, Buffer.concat([challenge.serverChallenge, clientChallenge])),
    clientChallenge
  ])

  const sessionBaseKey = hmacMd5(responseKey, proof)
  const exported = fixed?.sessionKey ?? randomBytes(16)
  const encryptedSessionKey = rc4(sessionBaseKey, exported)

  const domain = Buffer.from(identity.domain, 'utf16le')
  const user = Buffer.from(identity.username, 'utf16le')
  const workstation = Buffer.from(identity.workstation, 'utf16le')

  // Header, then the payload in the order the fields point at it.
  const HEADER = 88
  const parts = [lmResponse, ntResponse, domain, user, workstation, encryptedSessionKey]
  const message = Buffer.alloc(HEADER + parts.reduce((sum, p) => sum + p.length, 0))
  SIGNATURE.copy(message, 0)
  message.writeUInt32LE(3, 8)

  let offset = HEADER
  parts.forEach((part, index) => {
    const at = 12 + index * 8
    message.writeUInt16LE(part.length, at)
    message.writeUInt16LE(part.length, at + 2)
    message.writeUInt32LE(offset, at + 4)
    part.copy(message, offset)
    offset += part.length
  })
  message.writeUInt32LE(AUTHENTICATE_FLAGS, 60)
  // Version: claimed as Windows 10 build 19041, revision 15. A gateway does not
  // act on it, but an absent one alongside the version flag is malformed.
  Buffer.from([10, 0, 0x63, 0x45, 0, 0, 0, 15]).copy(message, 64)

  /**
   * The MIC signs all three messages with the session key, and the AV pairs had
   * to say it would be there before the proof above was computed. Without it a
   * modern gateway treats the response as tampered with rather than as
   * unsigned, so it is written whenever the challenge carried a timestamp —
   * which is the case that [MS-NLMP] 3.1.5.1.2 makes it mandatory for.
   */
  if (hasTimestamp(challenge.targetInfo) && !omitMic) {
    const mic = hmacMd5(exported, Buffer.concat([negotiate(), challenge.raw, message]))
    mic.copy(message, 72)
  }
  return message
}

/**
 * Checks that this build's crypto produces the values the specification says.
 *
 * NTLM leans on two primitives that are no longer ordinary — MD4, which is
 * implemented here, and HMAC-MD5, which comes from the runtime and is exactly
 * the kind of thing a hardened build withdraws. If either is off, every message
 * this file produces is wrong in a way the gateway reports as a reset or a
 * refusal, and no amount of looking at the message will show it.
 *
 * The values are from [MS-NLMP] 4.2.4, the same worked example the tests use.
 * Run once, on the first sign-in, because a unit test proves nothing about the
 * runtime the application is actually shipped on.
 */
let cryptoChecked = false
export function assertCryptoIsStandard(): void {
  if (cryptoChecked) return

  const key = Buffer.from(md4(Buffer.from('Password', 'utf16le')))
  if (key.toString('hex') !== 'a4f49c406510bdcab6824ee7c30fd852') {
    throw new Error('This build computes MD4 incorrectly, so NTLM cannot work here')
  }
  const ntowf = hmacMd5(key, Buffer.from('USERDomain', 'utf16le'))
  if (ntowf.toString('hex') !== '0c868a403bfd7a93a3001ef22ef02e3f') {
    throw new Error('This build computes HMAC-MD5 incorrectly, so NTLM cannot work here')
  }
  if (rc4(Buffer.from('0102030405', 'hex'), Buffer.alloc(16)).toString('hex') !==
    'b2396305f03dc027ccc3524a0a1118a8') {
    throw new Error('This build computes RC4 incorrectly, so NTLM cannot work here')
  }
  cryptoChecked = true
}

/** NTOWFv2: the password hash, keyed by the user and the domain they log into. */
function ntowfv2(identity: Identity): Buffer {
  const passwordHash = Buffer.from(md4(Buffer.from(identity.password, 'utf16le')))
  // The user is upper-cased and the domain is not, which is not symmetry anyone
  // would guess — a lower-cased domain here fails as a wrong password.
  const who = Buffer.from(identity.username.toUpperCase() + identity.domain, 'utf16le')
  return hmacMd5(passwordHash, who)
}

/** Adds the bindings and the "there is a MIC" flag to the AV pairs. */
function withExtras(
  targetInfo: Buffer,
  channelBinding?: Buffer,
  servicePrincipal?: string,
  withMic = true
): Buffer {
  const extras: Buffer[] = []
  if (channelBinding) extras.push(avPair(Av.CHANNEL_BINDINGS, gssChannelBindings(channelBinding)))
  if (servicePrincipal) {
    extras.push(avPair(Av.TARGET_NAME, Buffer.from(servicePrincipal, 'utf16le')))
  }
  if (hasTimestamp(targetInfo) && withMic) {
    const flags = Buffer.alloc(4)
    flags.writeUInt32LE(AV_FLAG_MIC, 0)
    extras.push(avPair(Av.FLAGS, flags))
  }
  if (extras.length === 0) return targetInfo

  // Everything up to the terminator, then the additions, then a new terminator.
  const end = findTerminator(targetInfo)
  return Buffer.concat([targetInfo.subarray(0, end), ...extras, avPair(Av.EOL, Buffer.alloc(0))])
}

/**
 * The `gss_channel_bindings_struct` the hash is taken over.
 *
 * Five empty address fields, then the application data — which for
 * `tls-server-end-point` is that literal prefix and the certificate's own hash.
 */
function gssChannelBindings(certificateHash: Buffer): Buffer {
  const application = Buffer.concat([
    Buffer.from('tls-server-end-point:', 'latin1'),
    certificateHash
  ])
  const struct = Buffer.alloc(20 + application.length)
  struct.writeUInt32LE(application.length, 16)
  application.copy(struct, 20)
  return createHash('md5').update(struct).digest()
}

function avPair(id: number, value: Buffer): Buffer {
  const pair = Buffer.alloc(4 + value.length)
  pair.writeUInt16LE(id, 0)
  pair.writeUInt16LE(value.length, 2)
  value.copy(pair, 4)
  return pair
}

function hasTimestamp(targetInfo: Buffer): boolean {
  return walk(targetInfo).some(({ id }) => id === Av.TIMESTAMP)
}

function findTerminator(targetInfo: Buffer): number {
  for (const { id, at } of walk(targetInfo)) if (id === Av.EOL) return at
  return targetInfo.length
}

function walk(targetInfo: Buffer): Array<{ id: number; at: number; length: number }> {
  const pairs: Array<{ id: number; at: number; length: number }> = []
  let at = 0
  while (at + 4 <= targetInfo.length) {
    const id = targetInfo.readUInt16LE(at)
    const length = targetInfo.readUInt16LE(at + 2)
    pairs.push({ id, at, length })
    if (id === Av.EOL) break
    at += 4 + length
  }
  return pairs
}

/** A length/capacity/offset triple, and the bytes it points at. */
function readField(message: Buffer, at: number): Buffer {
  const length = message.readUInt16LE(at)
  const offset = message.readUInt32LE(at + 4)
  if (offset + length > message.length) {
    throw new Error('The NTLM challenge points past its own end')
  }
  return Buffer.from(message.subarray(offset, offset + length))
}

function hmacMd5(key: Buffer, data: Buffer): Buffer {
  return createHmac('md5', key).update(data).digest()
}

/** RC4, for the one place NTLM needs it — Node's is behind the legacy provider. */
export function rc4(key: Buffer, data: Buffer): Buffer {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }

  const out = Buffer.alloc(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff
    j = (j + s[i]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff]
  }
  return out
}

/** 100-nanosecond intervals since 1601, which is how Windows counts. */
function windowsTime(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 10000n
}

function le64(value: bigint): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(value)
  return out
}

/** `DOMAIN\\user` and `user@domain` both mean the same thing to a gateway. */
export function splitIdentity(username: string, password: string, workstation: string): Identity {
  const backslash = username.indexOf('\\')
  if (backslash >= 0) {
    return {
      domain: username.slice(0, backslash),
      username: username.slice(backslash + 1),
      password,
      workstation
    }
  }
  const at = username.indexOf('@')
  if (at >= 0) {
    return { domain: username.slice(at + 1), username: username.slice(0, at), password, workstation }
  }
  return { domain: '', username, password, workstation }
}
