import { createConnection, type Socket } from 'net'
import { connect as tlsConnect, type TLSSocket } from 'tls'
import { randomBytes } from 'crypto'
import { WebSocketServer, type WebSocket } from 'ws'
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
class RdpGateway {
  private server: WebSocketServer | null = null
  private port = 0
  /** Session paths that have been handed out and not yet used up. */
  private expected = new Set<string>()

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
  async reserve(): Promise<string> {
    const port = await this.listen()
    const path = randomBytes(24).toString('hex')
    this.expected.add(path)
    return `ws://127.0.0.1:${port}/${path}`
  }

  private accept(client: WebSocket, url: string): void {
    const path = url.replace(/^\/+/, '').split('?')[0]
    if (!this.expected.delete(path)) {
      // Not one of ours, or a replay of one already spent.
      trace('refused a connection on an unknown or spent path')
      client.close(1008, 'Unknown session')
      return
    }
    void this.run(client).catch((err: Error) => {
      // The client reports most faults as a bare "General failure", so the
      // reason has to be findable somewhere. A close reason is capped at 123
      // bytes on the wire, which a certificate error easily exceeds.
      trace(`session failed — ${err.message}`)
      client.close(1011, err.message.slice(0, 120))
    })
  }

  private async run(client: WebSocket): Promise<void> {
    const raw = await readPdu(client)
    const request = decodeRequest(raw)
    trace(`request: ${raw.length} bytes, destination ${request.destination ?? 'none'}`)
    if (!request.destination) throw new Error('The client named no destination')
    if (!request.x224ConnectionPdu) throw new Error('The client sent no X.224 connection PDU')

    const { host, port } = splitDestination(request.destination)
    const server = await openTcp(host, port)
    trace(`connected to ${host}:${port}`)

    let secure: TLSSocket
    try {
      server.write(Buffer.from(request.x224ConnectionPdu))
      const confirm = await readTpkt(server)
      trace(`X.224 confirm: ${confirm.length} bytes, ${describeNegotiation(confirm)}`)

      secure = await startTls(server, host)
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

  /** Nothing should outlive the window that asked for it. */
  stop(): void {
    this.expected.clear()
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
 * where it stopped.
 */
function trace(message: string): void {
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
function readTpkt(socket: Socket): Promise<Uint8Array> {
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
function startTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    // RFC 6066 forbids an IP address as the server name, and Node warns then
    // ignores it. Hosts are reached by address as often as by name here, so
    // send SNI only when there is a name to send.
    const servername = isIpLiteral(host) ? undefined : host
    const secure = tlsConnect({ socket, servername, rejectUnauthorized: false })
    const fail = (err: Error): void => {
      secure.destroy()
      reject(new Error(`TLS with ${host} failed — ${err.message}`))
    }
    secure.once('secureConnect', () => {
      secure.off('error', fail)
      resolve(secure)
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
