import { createConnection, type Socket } from 'net'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import type { Duplex } from 'stream'
import { randomBytes } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { openThroughGateway } from './TsGateway'
import { askAboutCertificate } from './certificateVerifier'
import {
  RDCLEANPATH_VERSION,
  decodeRequest,
  encodeResponse,
  pduLength,
  splitDestination
} from '../../shared/rdcleanpath'

/**
 * A Devolutions Gateway, impersonated locally.
 *
 * IronRDP's WebAssembly client refuses to talk to an RDP server directly — a
 * proxy address is a required parameter, and the client opens that WebSocket
 * itself, so no transport can be handed to it. Rather than ship a real gateway
 * binary and give up on a single self-contained installer, this speaks the
 * gateway's dialect from inside the app.
 *
 * The proxy does more than relay. It performs the X.224 exchange and the TLS
 * handshake with the RDP server, then reports the server's certificate chain
 * back to the client, which needs it because CredSSP binds authentication to
 * the server's public key and the client cannot see the certificate itself.
 *
 * Bound to loopback on a port the operating system picks, with a random path
 * per session: any local process could otherwise connect to it and reach hosts
 * through this machine.
 */
/**
 * Where a reserved session is routed, and with what.
 *
 * Held in the main process and keyed by the session's own path, so the window
 * asks for an address and never learns the gateway behind it — least of all the
 * password, which would otherwise have to cross into the renderer the way the
 * host password already does for CredSSP.
 */
export interface RdpRoute {
  gateway?: {
    host: string
    port: number
    username: string
    password: string
    /** Reach a private address directly instead of through the gateway. */
    bypassLocal: boolean
  }
}

class RdpGateway {
  private server: WebSocketServer | null = null
  private port = 0
  /** Session paths that have been handed out and not yet used up. */
  private expected = new Map<string, RdpRoute>()
  /**
   * Why each session failed, kept until the window asks.
   *
   * The client reports almost everything as "General failure", and when this
   * side closes the socket it reports "not enough bytes" — the close reason
   * never reaches the screen. Every reason worth reading is on this side, so it
   * is held here and handed over on request.
   */
  private failures = new Map<string, string>()

  /** Starts the listener if it is not already up, and returns its port. */
  private async listen(): Promise<number> {
    if (this.server) return this.port

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (typeof address === 'string' || address === null) {
      throw new Error('The local gateway did not report a port')
    }

    this.server = server
    this.port = address.port
    server.on('connection', (socket, request) => this.accept(socket, request.url ?? ''))
    return this.port
  }

  /**
   * Reserves a session and returns the address to hand the client.
   *
   * The path is single-use: a token that stayed valid would let anything on
   * this machine reconnect through the proxy after the pane had gone.
   */
  async reserve(route: RdpRoute = {}): Promise<string> {
    const port = await this.listen()
    const path = randomBytes(24).toString('hex')
    this.expected.set(path, route)
    return `ws://127.0.0.1:${port}/${path}`
  }

  private accept(client: WebSocket, url: string): void {
    const path = url.replace(/^\/+/, '').split('?')[0]
    const route = this.expected.get(path)
    if (!route) {
      // Not one of ours, or a replay of one already spent.
      trace('refused a connection on an unknown or spent path')
      client.close(1008, 'Unknown session')
      return
    }
    this.expected.delete(path)
    void this.run(client, route).catch((err: Error) => {
      // A close reason is capped at 123 bytes on the wire, which a certificate
      // error easily exceeds — and the client shows its own message rather than
      // this one anyway. Kept whole here for the window to collect.
      trace(`session failed — ${err.message}`)
      this.failures.set(path, err.message)
      client.close(1011, err.message.slice(0, 120))
    })
  }

  private async run(client: WebSocket, route: RdpRoute): Promise<void> {
    const raw = await readPdu(client)
    const request = decodeRequest(raw)
    trace(`request: ${raw.length} bytes, destination ${request.destination ?? 'none'}`)
    if (!request.destination) throw new Error('The client named no destination')
    if (!request.x224ConnectionPdu) throw new Error('The client sent no X.224 connection PDU')

    const { host, port } = splitDestination(request.destination)
    const server = await reach(host, port, route)
    trace(`connected to ${host}:${port}`)

    let secure: TLSSocket
    try {
      server.write(Buffer.from(request.x224ConnectionPdu))
      const confirm = await readTpkt(server)
      trace(`X.224 confirm: ${confirm.length} bytes, ${describeNegotiation(confirm)}`)

      secure = await startTls(server, host, port)
      trace(`TLS up: ${secure.getProtocol() ?? 'unknown'}`)

      // The chain the client will bind CredSSP to. Its own TLS ended here, so
      // without this it has no idea which server it is authenticating against.
      const chain = certificateChain(secure)
      if (chain.length === 0) throw new Error('The server offered no certificate')

      const answer = encodeResponse({
        version: RDCLEANPATH_VERSION,
        x224ConnectionPdu: confirm,
        serverCertChain: chain,
        serverAddr: `${host}:${port}`
      })
      trace(`answering with ${chain.length} certificate(s), ${answer.length} bytes`)
      client.send(answer, { binary: true })
    } catch (err) {
      server.destroy()
      throw err
    }

    relay(client, secure)
  }

  /**
   * Why the session on this address failed, if it did. Taken rather than read:
   * one failure belongs to one attempt, and a stale reason shown against a
   * later one would be worse than none.
   */
  failureFor(proxyAddress: string): string | undefined {
    const path = proxyAddress.split('/').pop() ?? ''
    const reason = this.failures.get(path)
    this.failures.delete(path)
    return reason
  }

  /** Nothing should outlive the window that asked for it. */
  stop(): void {
    this.expected.clear()
    this.failures.clear()
    this.server?.close()
    this.server = null
    this.port = 0
  }
}

/**
 * A line in the terminal running the app.
 *
 * The client reports nearly every protocol fault as "General failure", so
 * without a record of what this side did, a failed session says nothing about
 * where it stopped. On in development, and switchable on in a shipped build
 * with `TERMINALDECK_RDP_TRACE=1` — the one case where it is worth the noise is
 * the one where someone is already stuck.
 */
// Read from the environment rather than through @electron-toolkit/utils, which
// imports electron: this file is covered by tests that run under plain Node,
// and pulling electron in there breaks every one of them at import time.
const tracing = process.env.NODE_ENV === 'development' || process.env.TERMINALDECK_RDP_TRACE === '1'

function trace(message: string): void {
  if (!tracing) return
  // eslint-disable-next-line no-console
  console.log(`[rdp gateway] ${message}`)
}

/**
 * What the server agreed to in its X.224 confirm.
 *
 * A refusal here is the commonest way a connection dies: the server wants
 * network-level authentication, or will not do TLS at all, and both look
 * identical from the window.
 */
function describeNegotiation(confirm: Uint8Array): string {
  // TPKT header, then the X.224 CC. An RDP_NEG_RSP is type 0x02 and an
  // RDP_NEG_FAILURE is 0x03; both sit at the end of the confirm.
  const type = confirm[11]
  if (type === 0x03) {
    const code = confirm[15]
    const REASONS: Record<number, string> = {
      1: 'the server requires SSL',
      2: 'the server requires CredSSP',
      3: 'the server requires CredSSP and this client did not offer it',
      5: 'the server rejected the requested protocol',
      6: 'the server requires CredSSP with early user authorisation'
    }
    return `negotiation FAILED — ${REASONS[code] ?? `reason code ${code}`}`
  }
  if (type === 0x02) {
    const selected = confirm[15]
    const PROTOCOLS: Record<number, string> = {
      0: 'standard RDP security',
      1: 'TLS',
      2: 'CredSSP',
      8: 'CredSSP with early user authorisation'
    }
    return `agreed on ${PROTOCOLS[selected] ?? `protocol ${selected}`}`
  }
  return 'no negotiation response'
}

/** Reads WebSocket frames until a whole RDCleanPath PDU has arrived. */
function readPdu(client: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let buffered = new Uint8Array(0)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const chunk = toBytes(data)
      const grown = new Uint8Array(buffered.length + chunk.length)
      grown.set(buffered)
      grown.set(chunk, buffered.length)
      buffered = grown

      // A request carrying a preconnection blob can cross a frame boundary, so
      // a short read is normal rather than a malformed client.
      const length = pduLength(buffered)
      if (length === null || buffered.length < length) return

      cleanup()
      resolve(buffered.subarray(0, length))
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error('The client closed before asking for anything'))
    }
    const cleanup = (): void => {
      client.off('message', onMessage)
      client.off('close', onClose)
      client.off('error', onClose)
    }

    client.on('message', onMessage)
    client.once('close', onClose)
    client.once('error', onClose)
  })
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data)
}

/**
 * Opens the stream the RDP exchange then runs over.
 *
 * The one place that decides *how* a host is reached. Everything above it —
 * X.224, TLS, the certificate chain, RDCleanPath — is written against a duplex
 * stream and does not care which of these produced it.
 */
async function reach(host: string, port: number, route: RdpRoute): Promise<Duplex> {
  const gateway = route.gateway
  if (!gateway) return openTcp(host, port)

  if (gateway.bypassLocal && isPrivateAddress(host)) {
    trace(`bypassing ${gateway.host} for the private address ${host}`)
    return openTcp(host, port)
  }

  trace(`reaching ${host}:${port} through the gateway ${gateway.host}:${gateway.port}`)
  return openThroughGateway(gateway, { host, port }, trace)
}

/**
 * Whether an address is one the gateway is meant to be skipped for.
 *
 * Only literals are judged. A name is not resolved to find out: that would put
 * a DNS lookup in front of every connection, and the answer a resolver gives
 * this machine says nothing about which side of the gateway the host is on.
 */
function isPrivateAddress(host: string): boolean {
  if (host === 'localhost') return true
  if (!isIpLiteral(host)) return false
  if (host.includes(':')) return host === '::1' || /^f[cd]/i.test(host)

  const [a, b] = host.split('.').map(Number)
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  // Link-local, which is what a machine gives itself when nothing answers DHCP.
  return a === 169 && b === 254
}

function openTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    socket.setNoDelay(true)
    const fail = (err: Error): void => {
      socket.destroy()
      reject(new Error(`${host}:${port} — ${err.message}`))
    }
    socket.once('connect', () => {
      socket.off('error', fail)
      resolve(socket)
    })
    socket.once('error', fail)
  })
}

/**
 * Reads one TPKT-framed message: version, reserved, then a 16-bit length that
 * counts the header too. The X.224 connection confirm always arrives this way.
 */
// Duplex rather than Socket throughout: the stream is a plain TCP connection
// for a host reached directly and a tunnel through a gateway otherwise, and
// nothing from here on needs to know which.
function readTpkt(socket: Duplex): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      if (buffered[0] !== 0x03) {
        cleanup()
        reject(new Error('The server did not answer with an X.224 connection confirm'))
        return
      }
      const length = buffered.readUInt16BE(2)
      if (length < 4 || length > 0xffff) {
        cleanup()
        reject(new Error('The server sent an implausible X.224 length'))
        return
      }
      if (buffered.length < length) return
      cleanup()
      resolve(new Uint8Array(buffered.subarray(0, length)))
    }
    const onEnd = (): void => {
      cleanup()
      reject(new Error('The server closed during the X.224 exchange'))
    }
    const cleanup = (): void => {
      socket.off('data', onData)
      socket.off('close', onEnd)
      socket.off('error', onEnd)
    }

    socket.on('data', onData)
    socket.once('close', onEnd)
    socket.once('error', onEnd)
  })
}

/**
 * Upgrades the connection, which is what RDP does after the X.224 confirm.
 *
 * The certificate is not verified: an RDP server's is self-signed by default,
 * and refusing those would reject nearly every host anyone wants to reach. The
 * chain is handed to the client instead, which is the point of reporting it —
 * trust is decided there, against what the user expects, rather than here.
 */
function startTls(socket: Duplex, host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    // RFC 6066 forbids an IP address as the server name, and Node warns then
    // ignores it. Hosts are reached by address as often as by name here, so
    // send SNI only when there is a name to send.
    const servername = isIpLiteral(host) ? undefined : host
    /**
     * Connected without rejecting an unverified certificate, and asked about it
     * afterwards. Node still checks the chain either way and reports the
     * verdict, so this gives the same answer as refusing outright would — and
     * leaves room for the one thing refusing cannot do, which is show the
     * fingerprint to the person and let them say yes.
     */
    const secure = tlsConnect({ socket, servername, rejectUnauthorized: false })
    const fail = (err: Error): void => {
      secure.destroy()
      reject(new Error(`TLS with ${host} failed — ${err.message}`))
    }
    secure.once('secureConnect', () => {
      secure.off('error', fail)
      const certificate = secure.getPeerCertificate()
      trace(
        secure.authorized
          ? `${host} presented a certificate this machine trusts`
          : `${host} presented an unverified certificate — ${secure.authorizationError ?? 'no reason given'}`
      )
      askAboutCertificate({
        host,
        port,
        der: certificate?.raw ?? Buffer.alloc(0),
        authorized: secure.authorized,
        problem: secure.authorizationError ? String(secure.authorizationError) : undefined,
        what: 'the desktop host'
      })
        .then((trusted) => {
          if (trusted) {
            resolve(secure)
            return
          }
          secure.destroy()
          reject(new Error(`The certificate offered by ${host} was not trusted`))
        })
        .catch((err: Error) => fail(err))
    })
    secure.once('error', fail)
  })
}

/** A dotted IPv4 quad or anything holding a colon, which makes it IPv6. */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

/** The server's certificate and everything it was issued by, leaf first. */
function certificateChain(secure: TLSSocket): Uint8Array[] {
  const chain: Uint8Array[] = []
  const seen = new Set<string>()
  let certificate = secure.getPeerCertificate(true)

  // A root certificate is its own issuer, so the walk has to stop on a repeat
  // rather than on an absent link.
  while (certificate && certificate.raw) {
    const fingerprint = certificate.fingerprint256 ?? certificate.raw.toString('base64')
    if (seen.has(fingerprint)) break
    seen.add(fingerprint)
    chain.push(new Uint8Array(certificate.raw))
    certificate = certificate.issuerCertificate
  }
  return chain
}

/** Carries bytes both ways until either end stops. */
function relay(client: WebSocket, server: TLSSocket): void {
  client.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    server.write(Buffer.from(toBytes(data)))
  })
  server.on('data', (chunk: Buffer) => {
    if (client.readyState === client.OPEN) client.send(chunk, { binary: true })
  })

  const stop = (): void => {
    server.destroy()
    if (client.readyState === client.OPEN) client.close()
  }
  client.once('close', stop)
  client.once('error', stop)
  server.once('close', stop)
  server.once('error', stop)
}

export const rdpGateway = new RdpGateway()
