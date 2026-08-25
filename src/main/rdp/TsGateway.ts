import { connect as tlsConnect, type TLSSocket } from 'tls'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { Duplex } from 'stream'
import { hostname } from 'os'
import {
  PacketType,
  channelCreate,
  dataPacket,
  describeError,
  failed,
  handshakeRequest,
  parseChannelResponse,
  parseDataPacket,
  parseHandshakeResponse,
  parseTunnelAuthResponse,
  parseTunnelResponse,
  PacketReader,
  readHeader,
  tunnelAuth,
  tunnelCreate
} from '../../shared/tsgu'
import { FrameReader, Opcode, encodeFrame } from '../../shared/wsframe'
import { ChunkReader, encodeChunk } from '../../shared/httpChunks'
import {
  assertCryptoIsStandard,
  authenticate,
  negotiate,
  parseChallenge,
  splitIdentity
} from './ntlm'
import { askAboutCertificate } from './certificateVerifier'

/**
 * A connection to a machine that sits behind a Remote Desktop Gateway.
 *
 * The gateway speaks [MS-TSGU]: an HTTPS request to `/remoteDesktopGateway/`
 * that is upgraded to a WebSocket, an NTLM sign-in carried in the headers of
 * that request, then a short exchange that opens a tunnel and a channel to one
 * named machine. After that the socket carries RDP, wrapped one packet at a
 * time.
 *
 * What comes back is an ordinary duplex stream. Everything above it — the X.224
 * exchange, TLS to the far host, the certificate chain the client needs for
 * CredSSP — is written against a stream and neither knows nor cares that this
 * one goes through a gateway.
 */

export interface GatewaySettings {
  host: string
  port: number
  username: string
  password: string
}

export interface Trace {
  (message: string): void
}

/** The most a single data packet can carry, from its sixteen-bit length. */
const MAX_PAYLOAD = 0xffff

export async function openThroughGateway(
  gateway: GatewaySettings,
  target: { host: string; port: number },
  trace: Trace
): Promise<Duplex> {
  /**
   * The WebSocket transport first, then the older one.
   *
   * Every gateway that speaks WebSocket is better served by it — one connection
   * instead of two, and no HTTP framing around every packet. But a gateway that
   * does not speak it gives no warning: the sign-in succeeds and the connection
   * is then dropped, with nothing said. So a failure at that point is not
   * final, and the older transport is tried before giving up.
   */
  try {
    return await openUpgraded(gateway, target, trace)
  } catch (err) {
    trace(`the WebSocket transport failed — ${(err as Error).message}`)
    trace('falling back to the older transport, which uses two connections')
    try {
      return await openLegacy(gateway, target, trace)
    } catch (firstError) {
      /**
       * A drop after the password proved good is the signature of a binding the
       * gateway did not accept, so the other shapes are tried before the TLS
       * version is doubted.
       */
      let legacyError = firstError
      if (isReset(firstError)) {
        for (const variant of VARIANTS.slice(1)) {
          trace(`retrying with ${variant.name}`)
          try {
            return await openLegacy(gateway, target, trace, undefined, variant)
          } catch (variantError) {
            if (!isReset(variantError)) throw variantError
            legacyError = variantError
          }
        }
      }

      /**
       * One more attempt, capped at TLS 1.2.
       *
       * Windows binds HTTP authentication to the connection it arrived on, and
       * its HTTP stack has never handled that reliably over TLS 1.3 — which is
       * why Windows Server ships with TLS 1.3 switched off for it. The failure
       * has a shape: everything works until the moment the sign-in *succeeds*,
       * because that is when the connection becomes an authenticated one, and
       * then the connection is dropped with nothing said.
       *
       * That is exactly the failure seen here, so it is worth one retry rather
       * than a diagnosis nobody can act on. Only after both transports have
       * failed, and only for the gateway — the desktop's own TLS is untouched.
       */
      if (isReset(legacyError)) {
        trace('retrying the older transport over TLS 1.2, in case the reset is TLS 1.3')
        try {
          return await openLegacy(gateway, target, trace, 'TLSv1.2')
        } catch (cappedError) {
          // The capped attempt's own message only matters when it says
          // something new; a second identical reset is noise.
          if (!isReset(cappedError)) throw cappedError
        }
      }

      const first = (err as Error).message
      const second =
        (legacyError as Error).message +
        (isReset(legacyError)
          ? `. Every shape of sign-in was tried (${VARIANTS.length} of them) and the gateway ` +
            'dropped each one after accepting the password, which points at its Extended ' +
            'Protection settings rather than at anything this end can change'
          : '')
      /**
       * The older transport's failure leads, because it is the one that was
       * expected to work: a gateway that refuses the upgrade is ordinary — the
       * Windows client fails it here too and falls back without complaint — so
       * reporting that first would put the uninteresting half in front.
       */
      throw new Error(
        first === second ? first : `${second} (the WebSocket transport failed first — ${first})`
      )
    }
  }
}

/**
 * The shapes of an authenticate message worth trying, in order.
 *
 * Not a diagnosis — a search, and a small one. Extended Protection is a server
 * setting with several positions, and every one of them refuses the same way:
 * the message is accepted as well formed, the password is checked and found
 * good, and only then is the binding examined and the connection dropped
 * without a word. Nothing in that is visible from outside, and each guess would
 * otherwise cost a rebuild and a person's attention, so the guesses are made
 * here in one run of about a second.
 *
 * The first entry is what the specification says a client should send, and is
 * what a correctly configured gateway wants.
 */
interface Variant {
  name: string
  channelBinding: boolean
  servicePrincipal?: (host: string) => string
  omitMic?: boolean
}

const VARIANTS: Variant[] = [
  {
    name: 'channel binding, the service name and a signature',
    channelBinding: true,
    servicePrincipal: (host) => `HTTP/${host}`
  },
  { name: 'channel binding and a signature, no service name', channelBinding: true },
  {
    name: 'the service name as a terminal service rather than HTTP',
    channelBinding: true,
    servicePrincipal: (host) => `TERMSRV/${host}`
  },
  {
    name: 'channel binding and the service name, unsigned',
    channelBinding: true,
    servicePrincipal: (host) => `HTTP/${host}`,
    omitMic: true
  }
]

/** Whether a failure was the connection being dropped rather than refused. */
function isReset(err: unknown): boolean {
  return /ECONNRESET|dropped the connection|closed the connection/.test((err as Error).message)
}

/** One connection, upgraded to a WebSocket. What a current gateway does. */
async function openUpgraded(
  gateway: GatewaySettings,
  target: { host: string; port: number },
  trace: Trace,
  maxVersion?: 'TLSv1.2'
): Promise<Duplex> {
  const socket = await connectTls(gateway, maxVersion)
  trace(`gateway TLS up: ${socket.getProtocol() ?? 'unknown'}`)

  try {
    const wire = new HttpWire(socket)
    await signIn(wire, gateway, channelBinding(socket), trace, {
      upgrade: true,
      what: 'the upgraded connection'
    })
    trace('gateway upgraded to a WebSocket')

    // A gateway can put its first frames in the same TCP segment as the 101,
    // and those bytes are already read. Handing them over rather than dropping
    // them is the difference between a tunnel that opens and one that waits
    // forever for a handshake response it has in fact already received.
    const tunnel = new Tunnel(websocketWire(socket, wire.takeRest()), trace)
    await tunnel.open(target)
    trace(`channel open to ${target.host}:${target.port}`)
    return tunnel
  } catch (err) {
    socket.destroy()
    throw err
  }
}

/**
 * Two connections and no upgrade, which is what an older gateway wants.
 *
 * `RDG_OUT_DATA` carries everything the gateway says, as a response body that
 * never ends. `RDG_IN_DATA` carries everything the client says, as a request
 * body that never ends. They are the same tunnel, and the gateway pairs them by
 * the connection id they share — so that id is minted once, here.
 */
async function openLegacy(
  gateway: GatewaySettings,
  target: { host: string; port: number },
  trace: Trace,
  maxVersion?: 'TLSv1.2',
  variant?: Variant
): Promise<Duplex> {
  const connectionId = `{${randomUUID()}}`
  const correlationId = `{${randomUUID()}}`
  let outgoing: TLSSocket | undefined
  let incoming: TLSSocket | undefined

  try {
    incoming = await connectTls(gateway, maxVersion)
    const inboundWire = new HttpWire(incoming)
    const inbound = await signIn(inboundWire, gateway, channelBinding(incoming), trace, {
      method: 'RDG_OUT_DATA',
      connectionId,
      correlationId,
      what: 'the reading connection',
      variant,
      // The response to this one is the tunnel itself and never ends.
      drainFinalBody: false
    })
    trace(`the gateway accepted the reading connection (${inbound.status})`)

    outgoing = await connectTls(gateway, maxVersion)
    const outboundWire = new HttpWire(outgoing)
    await signIn(outboundWire, gateway, channelBinding(outgoing), trace, {
      method: 'RDG_IN_DATA',
      connectionId,
      correlationId,
      what: 'the writing connection',
      variant
    })
    trace('the gateway accepted the writing connection')

    /**
     * The writing connection is asked for a second time, now with a body that
     * is never finished. The first request proved who is calling; this one is
     * the one whose body the packets are written into, one chunk each.
     */
    outboundWire.send(
      request(
        gateway,
        { connectionId, correlationId },
        { connection: 'Keep-Alive', 'transfer-encoding': 'chunked' },
        'RDG_IN_DATA'
      )
    )

    const wire = chunkedWire(incoming, outgoing, inboundWire.takeRest(), {
      chunked: (inbound.headers.get('transfer-encoding') ?? '').includes('chunked'),
      discardFirst: SEED_PAYLOAD
    })
    const tunnel = new Tunnel(wire, trace)
    await tunnel.open(target)
    trace(`channel open to ${target.host}:${target.port} through the older transport`)
    return tunnel
  } catch (err) {
    incoming?.destroy()
    outgoing?.destroy()
    throw err
  }
}

/**
 * The random bytes a gateway sends once it has accepted the reading connection,
 * before any packet. [MS-TSGU] 3.3.5.1 does not fix the length; ten is what
 * every implementation observes, and it is the number the reference client uses.
 */
const SEED_PAYLOAD = 10

function connectTls(gateway: GatewaySettings, maxVersion?: 'TLSv1.2'): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    /**
     * Connected without refusing an unverified certificate, then asked about
     * it. A gateway issued by a public authority — which is the usual case, and
     * is what the certificate `getPeerCertificate` returns will say — is
     * accepted with nothing shown at all; anything else becomes a question with
     * the fingerprint in it. Node checks the chain either way.
     */
    const socket = tlsConnect(
      {
        host: gateway.host,
        port: gateway.port,
        servername: gateway.host,
        rejectUnauthorized: false,
        ...(maxVersion ? { maxVersion } : {})
      },
      () => {
        socket.off('error', fail)
        socket.setNoDelay(true)
        const certificate = socket.getPeerCertificate()
        askAboutCertificate({
          host: gateway.host,
          port: gateway.port,
          der: certificate?.raw ?? Buffer.alloc(0),
          authorized: socket.authorized,
          problem: socket.authorizationError ? String(socket.authorizationError) : undefined,
          what: 'the gateway'
        })
          .then((trusted) => {
            if (trusted) {
              resolve(socket)
              return
            }
            socket.destroy()
            reject(
              new Error(`The certificate offered by the gateway ${gateway.host} was not trusted`)
            )
          })
          .catch(fail)
      }
    )
    const fail = (err: Error): void => {
      socket.destroy()
      reject(new Error(`The gateway ${gateway.host}:${gateway.port} — ${err.message}`))
    }
    socket.once('error', fail)
  })
}

/**
 * The `tls-server-end-point` binding: a hash of the gateway's own certificate.
 *
 * A gateway with Extended Protection turned on refuses a sign-in that does not
 * name the connection it arrived over, and the refusal is a plain "access
 * denied" — indistinguishable from a wrong password. So it is always computed.
 * The hash is SHA-256 unless the certificate was signed with something stronger.
 */
function channelBinding(socket: TLSSocket): Buffer | undefined {
  const certificate = socket.getPeerCertificate()
  if (!certificate || !certificate.raw) return undefined
  return createHash('sha256').update(certificate.raw).digest()
}

/** One HTTP request and response at a time, over a socket that stays open. */
class HttpWire {
  private buffered = Buffer.alloc(0)
  private waiting: ((chunk: Buffer) => void) | null = null

  constructor(private socket: TLSSocket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffered = Buffer.concat([this.buffered, chunk])
      this.waiting?.(this.buffered)
    })
  }

  send(request: string): void {
    this.socket.write(request)
  }

  /**
   * Reads until the headers are complete, then drains any body they announce.
   *
   * `waitingFor` names the step in the sign-in this call belongs to. A reset
   * says nothing on its own — the same `ECONNRESET` means a rejected message,
   * a blocked account or a network in the way — and which request it landed on
   * is most of what separates them.
   */
  async response(
    waitingFor: string,
    /**
     * False for the response that *is* the tunnel. `RDG_OUT_DATA` is answered
     * with a body that never ends, so draining it would never return.
     */
    drainBody = true
  ): Promise<{ status: number; headers: Map<string, string> }> {
    const head = await this.until((buffer) => buffer.indexOf('\r\n\r\n') + 1, waitingFor)
    const text = head.toString('latin1')
    const lines = text.split('\r\n')
    const status = Number(lines[0].split(' ')[1])

    const headers = new Map<string, string>()
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      // A 401 offers several schemes, one header each; keep them all.
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value)
    }

    const headerEnd = text.indexOf('\r\n\r\n') + 4
    this.buffered = this.buffered.subarray(headerEnd)

    const length = Number(headers.get('content-length') ?? 0)
    if (drainBody && length > 0) {
      // The body has to go, or it would be read as the start of the next
      // response — the whole exchange happens on this one connection.
      await this.until((buffer) => (buffer.length >= length ? length : 0), waitingFor)
      this.buffered = this.buffered.subarray(length)
    }
    return { status, headers }
  }

  /** Whatever is left unread, which after the upgrade is WebSocket data. */
  takeRest(): Buffer {
    const rest = this.buffered
    this.buffered = Buffer.alloc(0)
    this.socket.removeAllListeners('data')
    return rest
  }

  private until(ready: (buffer: Buffer) => number, waitingFor: string): Promise<Buffer> {
    /**
     * How long the gateway thought about it before dropping the connection.
     *
     * The number separates two quite different culprits. A reset that arrives
     * in a millisecond or two was sent by something that did no work — a
     * middlebox, a firewall — while one that takes tens or hundreds of
     * milliseconds came from a server that looked the account up first and then
     * decided against it.
     */
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (ready(this.buffered) > 0) {
          this.waiting = null
          this.socket.off('error', onError)
          this.socket.off('close', onClose)
          resolve(this.buffered)
          return true
        }
        return false
      }
      const onError = (err: Error): void =>
        reject(
          new Error(
            `The gateway dropped the connection while waiting for ${waitingFor}, ` +
              `after ${Date.now() - started} ms — ${err.message}`
          )
        )
      const onClose = (): void =>
        reject(
          new Error(
            `The gateway closed the connection while waiting for ${waitingFor}, ` +
              `after ${Date.now() - started} ms`
          )
        )

      this.socket.once('error', onError)
      this.socket.once('close', onClose)
      this.waiting = () => check()
      check()
    })
  }
}

/**
 * The NTLM sign-in, and the upgrade on the back of it.
 *
 * Three requests to the same URL on the same connection: one that offers NTLM,
 * one that answers the challenge, and — because that last one also carries the
 * WebSocket headers — the upgrade itself.
 */
interface SignIn {
  /** `RDG_OUT_DATA` for both transports' first request; the writing connection
   *  of the older one uses `RDG_IN_DATA`. */
  method?: string
  /** Reused across the two connections of the older transport, which is how the
   *  gateway knows they are one tunnel. Minted here when nobody supplies one. */
  connectionId?: string
  /** Likewise shared, so both connections appear as one session in the
   *  gateway's own records. */
  correlationId?: string
  /** Ask for the WebSocket upgrade on the request that carries the answer. */
  upgrade?: boolean
  /** False when the accepted response's body is the tunnel and never ends. */
  drainFinalBody?: boolean
  /**
   * What to call this connection when something goes wrong on it. The older
   * transport has two, and a reset that does not say which is as good as
   * silent.
   */
  what?: string
  /** Which shape of authenticate message to send. See VARIANTS. */
  variant?: Variant
}

async function signIn(
  wire: HttpWire,
  gateway: GatewaySettings,
  binding: Buffer | undefined,
  trace: Trace,
  how: SignIn = {}
): Promise<{ status: number; headers: Map<string, string> }> {
  // Before anything is sent: a runtime that computes these differently produces
  // messages the gateway rejects without ever saying why.
  assertCryptoIsStandard()

  const identity = splitIdentity(gateway.username, gateway.password, hostname())
  const key = randomBytes(16).toString('base64')
  /**
   * One id for the whole exchange, not one per request.
   *
   * The gateway keys the half-finished sign-in by this header, so a fresh id on
   * the request carrying the answer arrives as a challenge nobody asked for —
   * and the connection is reset rather than refused, which says nothing about
   * why. The older transport goes further and shares one id across both of its
   * connections, which is how they are recognised as one tunnel.
   */
  const ids: Ids = {
    connectionId: how.connectionId ?? `{${randomUUID()}}`,
    correlationId: how.correlationId ?? `{${randomUUID()}}`
  }
  const method = how.method ?? 'RDG_OUT_DATA'

  trace(`signing in to ${gateway.host} as ${identity.domain || '(no domain)'}\\${identity.username}`)
  wire.send(
    request(
      gateway,
      ids,
      { connection: 'Keep-Alive', authorization: `NTLM ${negotiate().toString('base64')}` },
      method
    )
  )
  const what = how.what ?? 'the connection'
  const offered = await wire.response(`the NTLM challenge on ${what}`)
  if (offered.status !== 401) {
    // A gateway that lets the first request through unchallenged wants no
    // credentials at all, which no Windows deployment does.
    throw new Error(`The gateway answered ${offered.status} instead of asking for credentials`)
  }

  const challengeHeader = offered.headers.get('www-authenticate') ?? ''
  const token = /NTLM ([A-Za-z0-9+/=]+)/.exec(challengeHeader)
  if (!token) {
    // Worth naming precisely: a gateway that offers only Negotiate needs SPNEGO
    // around the same NTLM messages, which is a different piece of work.
    const schemes = challengeHeader || 'none'
    throw new Error(
      `The gateway did not offer NTLM — it offered ${schemes}. Only NTLM is implemented here`
    )
  }

  const challenge = parseChallenge(Buffer.from(token[1], 'base64'))
  trace(`gateway challenged as ${challenge.targetName || 'an unnamed domain'}`)

  const variant = how.variant ?? VARIANTS[0]
  const answer = authenticate(identity, challenge, {
    channelBinding: variant.channelBinding ? binding : undefined,
    servicePrincipal: variant.servicePrincipal?.(gateway.host),
    omitMic: variant.omitMic
  })
  const reply = request(
      gateway,
      ids,
      how.upgrade
        ? {
            authorization: `NTLM ${answer.toString('base64')}`,
            upgrade: 'websocket',
            connection: 'Upgrade',
            'sec-websocket-key': key,
            'sec-websocket-version': '13'
          }
        : { connection: 'Keep-Alive', authorization: `NTLM ${answer.toString('base64')}` },
      method
    )
  trace(
    `${how.upgrade ? 'answering the challenge and asking for the WebSocket upgrade' : 'answering the challenge'}` +
      ` — ${reply.length} bytes, of which ${answer.length} are the NTLM message`
  )
  wire.send(reply)

  let upgraded
  try {
    upgraded = await wire.response(
      `the answer to the sign-in on ${what}`,
      how.drainFinalBody !== false
    )
  } catch (err) {
    /**
     * A reset here has two causes with one symptom: the sign-in was rejected,
     * or it was accepted and this gateway does not do WebSocket at all. No
     * guess is needed any more — the caller tries the older transport next,
     * which answers the question by working or by failing the same way.
     */
    throw err
  }

  trace(`the gateway answered ${upgraded.status}`)
  if (upgraded.status === 401) {
    throw new Error('The gateway refused these credentials')
  }
  if (how.upgrade && upgraded.status !== 101) {
    throw new Error(
      `The gateway would not upgrade the connection to a WebSocket — it answered ${upgraded.status}`
    )
  }
  if (!how.upgrade && upgraded.status !== 200) {
    throw new Error(`The gateway answered ${upgraded.status} to the sign-in`)
  }
  return upgraded
}

/**
 * One HTTP request, as text.
 *
 * Written by hand rather than through Node's HTTP client, which cannot express
 * any of this: the sign-in needs several requests on one connection it also
 * hands back, and one of these requests has a body that is never finished.
 */
interface Ids {
  /** Ties the requests of one tunnel together, both connections included. */
  connectionId: string
  /**
   * What the gateway files its own logging under. The reference client always
   * sends one, and a gateway is entitled to expect it — this is not a hint or a
   * nicety, it is part of the request every Windows client makes.
   */
  correlationId: string
}

function request(
  gateway: GatewaySettings,
  ids: Ids,
  headers: Record<string, string>,
  method = 'RDG_OUT_DATA'
): string {
  const lines = [
    `${method} /remoteDesktopGateway/ HTTP/1.1`,
    `Host: ${gateway.host}`,
    'Accept: */*',
    'Cache-Control: no-cache',
    'Pragma: no-cache',
    'User-Agent: MS-RDGateway/1.0',
    `RDG-Connection-Id: ${ids.connectionId}`,
    `RDG-Correlation-Id: ${ids.correlationId}`,
    /**
     * Stated even though it is zero, which is what the reference client does.
     * `RDG_OUT_DATA` is not a method http.sys knows the shape of, and a request
     * with neither a length nor a transfer encoding leaves the body open-ended.
     * The one request that genuinely has an endless body says so instead.
     */
    ...(headers['transfer-encoding'] ? [] : ['Content-Length: 0']),
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)
  ]
  return `${lines.join('\r\n')}\r\n\r\n`
}

/**
 * The tunnel, once the socket is speaking WebSocket.
 *
 * A duplex stream on the outside: writes become data packets, and data packets
 * become readable bytes. The handshake that precedes that is four exchanges,
 * each of which can refuse with a reason worth repeating to the person waiting.
 */
/**
 * How tunnel packets get on and off the wire.
 *
 * There are two transports and the tunnel above them is identical, so the
 * difference is confined here. On a modern gateway a packet travels as the
 * payload of a WebSocket frame; on an older one it is one chunk of an HTTP
 * request body going out, and arrives inside the chunked response body of a
 * second connection coming back.
 */
export interface TunnelWire {
  /** Puts one packet on the wire, whole. */
  send(packet: Uint8Array): void
  /** Bytes arriving from the gateway. Not packet-aligned — see PacketReader. */
  onData(handler: (bytes: Uint8Array) => void): void
  onEnd(handler: () => void): void
  onError(handler: (err: Error) => void): void
  destroy(): void
}

/** Packets as WebSocket frames, which is what a current gateway speaks. */
export function websocketWire(socket: Duplex, alreadyRead: Uint8Array): TunnelWire {
  const frames = new FrameReader()
  let deliver: (bytes: Uint8Array) => void = () => {}
  let fail: (err: Error) => void = () => {}
  let end: () => void = () => {}

  const onChunk = (chunk: Buffer): void => {
    let received
    try {
      received = frames.push(chunk)
    } catch (err) {
      fail(err as Error)
      return
    }
    for (const frame of received) {
      if (frame.opcode === Opcode.Close) {
        end()
        return
      }
      if (frame.opcode === Opcode.Ping) {
        socket.write(encodeFrame(Opcode.Pong, frame.payload, randomBytes(4)))
        continue
      }
      if (frame.opcode === Opcode.Binary) deliver(frame.payload)
    }
  }

  socket.on('data', onChunk)
  socket.on('error', (err) => fail(err))
  socket.on('close', () => end())

  return {
    send: (packet) => socket.write(encodeFrame(Opcode.Binary, packet, randomBytes(4))),
    onData: (handler) => {
      deliver = handler
      // Bytes carried over from the upgrade, read before anything was listening.
      if (alreadyRead.length > 0) onChunk(Buffer.from(alreadyRead))
    },
    onEnd: (handler) => (end = handler),
    onError: (handler) => (fail = handler),
    destroy: () => socket.destroy()
  }
}

/**
 * Packets as HTTP chunks, which is what a gateway that cannot upgrade wants.
 *
 * Two connections, because a single HTTP exchange only goes one way and neither
 * direction ever ends: `RDG_OUT_DATA` is a response body that keeps arriving,
 * and `RDG_IN_DATA` is a request body that keeps being written. They are paired
 * by the connection id both carry.
 */
export function chunkedWire(
  incoming: TLSSocket,
  outgoing: TLSSocket,
  alreadyRead: Uint8Array,
  options: { chunked: boolean; discardFirst: number }
): TunnelWire {
  const chunks = new ChunkReader()
  let toDiscard = options.discardFirst
  let deliver: (bytes: Uint8Array) => void = () => {}
  let fail: (err: Error) => void = () => {}
  let end: () => void = () => {}

  const onChunk = (chunk: Buffer): void => {
    let payloads: Uint8Array[]
    try {
      payloads = options.chunked ? chunks.push(chunk) : [chunk]
    } catch (err) {
      fail(err as Error)
      return
    }
    for (const payload of payloads) {
      /**
       * [MS-TSGU] 3.3.5.1: once the request is finally accepted the gateway
       * sends a short run of random bytes before anything else — ten of them in
       * practice. Read as a packet header it is nonsense, so it goes here,
       * after the chunk decoding it arrives inside.
       */
      let bytes = payload
      if (toDiscard > 0) {
        const drop = Math.min(toDiscard, bytes.length)
        toDiscard -= drop
        bytes = bytes.subarray(drop)
        if (bytes.length === 0) continue
      }
      deliver(bytes)
    }
    if (options.chunked && chunks.finished) end()
  }

  incoming.on('data', onChunk)
  incoming.on('error', (err) => fail(err))
  incoming.on('close', () => end())
  outgoing.on('error', (err) => fail(err))
  outgoing.on('close', () => end())

  return {
    send: (packet) => outgoing.write(Buffer.from(encodeChunk(packet))),
    onData: (handler) => {
      deliver = handler
      if (alreadyRead.length > 0) onChunk(Buffer.from(alreadyRead))
    },
    onEnd: (handler) => (end = handler),
    onError: (handler) => (fail = handler),
    destroy: () => {
      incoming.destroy()
      outgoing.destroy()
    }
  }
}

export class Tunnel extends Duplex {
  private packets = new PacketReader()
  private pending: Array<(packet: Uint8Array) => void> = []
  /**
   * Packets that arrived before anything was waiting for them.
   *
   * The bytes carried over from the upgrade are read in the constructor, which
   * is before `open` has asked for anything — and a gateway that answers
   * quickly can also beat the next `expect` to the socket. Dropping either
   * leaves the handshake waiting for a response it has already been given.
   */
  private arrived: Uint8Array[] = []
  private open_ = false

  constructor(
    private wire: TunnelWire,
    private trace: Trace
  ) {
    super()
    this.wire.onError((err) => this.destroy(err))
    this.wire.onEnd(() => this.push(null))
    this.wire.onData((bytes) => this.onBytes(bytes))
  }

  async open(target: { host: string; port: number }): Promise<void> {
    this.sendPacket(handshakeRequest())
    const handshake = parseHandshakeResponse(await this.expect(PacketType.HandshakeResponse))
    this.check(handshake.errorCode, 'The gateway refused the handshake')
    this.trace(`gateway version ${handshake.serverVersion}`)

    this.sendPacket(tunnelCreate())
    const tunnel = parseTunnelResponse(await this.expect(PacketType.TunnelResponse))
    this.check(tunnel.errorCode, 'The gateway would not open a tunnel')
    if (tunnel.consentMessage) {
      // Shown rather than agreed to on the person's behalf: a consent banner is
      // a statement someone is meant to read.
      this.trace(`gateway consent message: ${tunnel.consentMessage}`)
    }

    this.sendPacket(tunnelAuth(hostname()))
    const authorised = parseTunnelAuthResponse(await this.expect(PacketType.TunnelAuthResponse))
    this.check(authorised.errorCode, 'The gateway would not authorise the tunnel')

    this.sendPacket(channelCreate(target.host, target.port))
    const channel = parseChannelResponse(await this.expect(PacketType.ChannelResponse))
    this.check(channel.errorCode, `The gateway could not reach ${target.host}`)
    this.open_ = true
  }

  private check(code: number, what: string): void {
    if (failed(code)) throw new Error(`${what} — ${describeError(code)}`)
  }

  private onBytes(bytes: Uint8Array): void {
    let packets
    try {
      packets = this.packets.push(bytes)
    } catch (err) {
      this.destroy(err as Error)
      return
    }
    for (const packet of packets) this.onPacket(packet)
  }

  private onPacket(packet: Uint8Array): void {
    const header = readHeader(packet)
    if (!header) return

    if (header.type === PacketType.Data) {
      if (!this.open_) return
      try {
        this.push(Buffer.from(parseDataPacket(packet)))
      } catch (err) {
        this.destroy(err as Error)
      }
      return
    }

    // A keepalive needs no answer, and a service message is for a person rather
    // than for this code. Neither should look like a protocol error.
    if (header.type === PacketType.Keepalive) return
    if (header.type === PacketType.ServiceMessage) {
      this.trace('the gateway sent a service message')
      return
    }

    const waiter = this.pending.shift()
    if (waiter) waiter(packet)
    else this.arrived.push(packet)
  }

  /** Waits for the next packet that is not data, and says what was expected. */
  private expect(type: PacketType): Promise<Uint8Array> {
    // Resolved whatever the type: each parser checks it and names both what it
    // wanted and what came, which is more use than a second check here.
    void type

    const already = this.arrived.shift()
    if (already) return Promise.resolve(already)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The gateway did not answer within 30 seconds'))
      }, 30_000)
      this.pending.push((packet) => {
        clearTimeout(timer)
        resolve(packet)
      })
    })
  }

  private sendPacket(packet: Uint8Array): void {
    this.wire.send(packet)
  }

  _read(): void {
    // Pushed as frames arrive; nothing to pull.
  }

  _write(chunk: Buffer, _encoding: string, done: (err?: Error) => void): void {
    try {
      // A data packet states its payload length in sixteen bits, so anything
      // larger has to go as several. TLS records keep writes well under this in
      // practice, which is exactly why it would not be found later.
      for (let at = 0; at < chunk.length; at += MAX_PAYLOAD) {
        this.sendPacket(dataPacket(chunk.subarray(at, at + MAX_PAYLOAD)))
      }
      done()
    } catch (err) {
      done(err as Error)
    }
  }

  _destroy(err: Error | null, done: (err: Error | null) => void): void {
    this.wire.destroy()
    done(err)
  }
}
