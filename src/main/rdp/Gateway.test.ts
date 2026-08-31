import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { createServer as createTcpServer, type Server, type Socket } from 'net'
import { TLSSocket, createSecureContext } from 'tls'
import WebSocket from 'ws'
import { rdpGateway } from './Gateway'
import { setCertificateVerifier } from './certificateVerifier'
import { TEST_CERT, TEST_KEY } from './testCert'
import {
  RDCLEANPATH_VERSION,
  decodeRequest,
  encodeResponse,
  pduLength
} from '../../shared/rdcleanpath'

/**
 * The stand-in host below signs its own certificate, so the trust question has
 * an answer here rather than the refusal the main process would otherwise get
 * before it installs the real one. Saying so out loud is the point: an
 * unverifiable certificate is accepted only because this test says to.
 */
beforeAll(() => {
  setCertificateVerifier(async () => true)
})

/**
 * A stand-in for an RDP host: answers the X.224 connection request, upgrades to
 * TLS, then echoes. Enough to prove the gateway does the whole dance — the part
 * that cannot be checked by reasoning about it.
 */
interface FakeServer {
  port: number
  close: () => void
  /** Resolves with whatever arrived over TLS after the handshake. */
  received: Promise<Buffer>
  sendAfterTls: (data: Buffer) => void
}

function tpkt(payload: number[]): Buffer {
  const length = payload.length + 4
  return Buffer.from([0x03, 0x00, (length >> 8) & 0xff, length & 0xff, ...payload])
}

async function startFakeRdpServer(options: { badConfirm?: boolean } = {}): Promise<FakeServer> {
  let resolveReceived: (b: Buffer) => void = () => undefined
  const received = new Promise<Buffer>((resolve) => (resolveReceived = resolve))
  let secure: TLSSocket | null = null

  const server: Server = createTcpServer((socket: Socket) => {
    socket.once('data', () => {
      // The X.224 connection confirm, then RDP upgrades the same socket to TLS.
      socket.write(options.badConfirm ? Buffer.from([0xff, 0x00, 0x00, 0x04]) : tpkt([0x0e, 0xd0]))
      if (options.badConfirm) return

      secure = new TLSSocket(socket, {
        isServer: true,
        secureContext: createSecureContext({ key: TEST_KEY, cert: TEST_CERT })
      })
      secure.once('data', (chunk: Buffer) => resolveReceived(chunk))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')

  return {
    port: address.port,
    close: () => server.close(),
    received,
    sendAfterTls: (data) => secure?.write(data)
  }
}

/** The request the IronRDP client sends, built by hand. */
function request(destination: string): Uint8Array {
  // Reuses the writer, then rewrites the tags a request carries. Simpler: build
  // the DER directly, which is what the codec's own tests do too.
  const utf8 = [...new TextEncoder().encode(destination)]
  const body = [
    0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e, // [0] version 3390
    0xa2, utf8.length + 2, 0x0c, utf8.length, ...utf8, // [2] destination
    0xa6, 0x06, 0x04, 0x04, 0x03, 0x00, 0x00, 0x13 // [6] X.224 PDU
  ]
  return Uint8Array.from([0x30, body.length, ...body])
}

function open(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** The first whole PDU the gateway sends back. */
function firstPdu(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data: Buffer) => {
      const bytes = new Uint8Array(data)
      const length = pduLength(bytes)
      if (length === null) reject(new Error('not a PDU'))
      else resolve(bytes.subarray(0, length))
    })
    socket.once('close', (code, reason) =>
      reject(new Error(`closed ${code} ${reason.toString()}`))
    )
  })
}

const sockets: WebSocket[] = []
const servers: FakeServer[] = []

afterEach(() => {
  for (const s of sockets.splice(0)) s.close()
  for (const s of servers.splice(0)) s.close()
  rdpGateway.stop()
})

describe('the local gateway', () => {
  it('hands out a loopback address with a per-session path', async () => {
    const first = await rdpGateway.reserve()
    const second = await rdpGateway.reserve()
    expect(first).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/)
    // Reusing a path would let anything on this machine reconnect through the
    // proxy after the pane it belonged to had gone.
    expect(first).not.toBe(second)
  })

  it('refuses a path it never handed out', async () => {
    const url = await rdpGateway.reserve()
    const bogus = url.replace(/\/[0-9a-f]+$/, '/' + 'f'.repeat(48))
    const socket = new WebSocket(bogus)
    sockets.push(socket)

    const code = await new Promise<number>((resolve) => socket.once('close', resolve))
    expect(code).toBe(1008)
  })

  it('refuses to reuse a path that was already spent', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const url = await rdpGateway.reserve()

    const first = await open(url)
    sockets.push(first)
    first.send(request(`127.0.0.1:${server.port}`))
    await firstPdu(first)

    const second = new WebSocket(url)
    sockets.push(second)
    const code = await new Promise<number>((resolve) => second.once('close', resolve))
    expect(code).toBe(1008)
  })

  it('performs the X.224 exchange and reports the certificate chain', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    socket.send(request(`127.0.0.1:${server.port}`))
    const answer = decodeRequest(await firstPdu(socket))

    expect(answer.version).toBe(RDCLEANPATH_VERSION)
    // The X.224 confirm the fake server sent, passed straight back.
    expect([...answer.x224ConnectionPdu!]).toEqual([0x03, 0x00, 0x00, 0x06, 0x0e, 0xd0])
  })

  it('stops the session when the certificate is not trusted', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    // The person said no, or a build never installed a verifier at all: either
    // way the session must stop rather than carry on over a certificate nobody
    // vouched for.
    setCertificateVerifier(async () => false)
    const closed = new Promise<string>((resolve) =>
      socket.once('close', (_code, reason) => resolve(reason.toString()))
    )
    socket.send(request(`127.0.0.1:${server.port}`))

    expect(await closed).toMatch(/was not trusted/)
    setCertificateVerifier(async () => true)
  })

  it('keeps the reason a session failed, for the window to collect', async () => {
    const address = await rdpGateway.reserve()
    const socket = await open(address)
    sockets.push(socket)

    const closed = new Promise((resolve) => socket.once('close', resolve))
    // Nothing is listening on this port, so the dial fails with a reason the
    // client would otherwise replace with "General failure".
    socket.send(request('127.0.0.1:1'))
    await closed

    const reason = rdpGateway.failureFor(address)
    expect(reason).toMatch(/127\.0\.0\.1:1/)
    // Taken, not read: a reason belongs to the one attempt that produced it.
    expect(rdpGateway.failureFor(address)).toBeUndefined()
  })

  it('carries the certificate the server actually presented', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    socket.send(request(`127.0.0.1:${server.port}`))
    const raw = await firstPdu(socket)

    // The chain sits under [7]; the leaf is the DER of the test certificate,
    // which the client needs to bind CredSSP to. Compare against the PEM body.
    const expected = Buffer.from(
      TEST_CERT.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, ''),
      'base64'
    )
    expect(Buffer.from(raw).includes(expected)).toBe(true)
  })

  it('relays what the client sends once the handshake is done', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    socket.send(request(`127.0.0.1:${server.port}`))
    await firstPdu(socket)

    socket.send(Buffer.from([0x11, 0x22, 0x33]))
    expect([...(await server.received)]).toEqual([0x11, 0x22, 0x33])
  })

  it('closes with a reason when the destination refuses the connection', async () => {
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)
    // Port 1 on loopback: nothing listens there.
    socket.send(request('127.0.0.1:1'))

    const reason = await new Promise<string>((resolve) =>
      socket.once('close', (_code, r) => resolve(r.toString()))
    )
    expect(reason).toMatch(/127\.0\.0\.1:1/)
  })

  it('closes with a reason when the server does not answer X.224 properly', async () => {
    const server = await startFakeRdpServer({ badConfirm: true })
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    socket.send(request(`127.0.0.1:${server.port}`))
    const reason = await new Promise<string>((resolve) =>
      socket.once('close', (_code, r) => resolve(r.toString()))
    )
    expect(reason).toMatch(/X\.224/)
  })

  it('answers a request that arrived split across frames', async () => {
    const server = await startFakeRdpServer()
    servers.push(server)
    const socket = await open(await rdpGateway.reserve())
    sockets.push(socket)

    const whole = request(`127.0.0.1:${server.port}`)
    socket.send(whole.subarray(0, 6))
    socket.send(whole.subarray(6))

    const answer = decodeRequest(await firstPdu(socket))
    expect(answer.version).toBe(RDCLEANPATH_VERSION)
  })
})

describe('encodeResponse against the gateway’s own reader', () => {
  it('survives a chain of realistic size', () => {
    const chain = [Buffer.alloc(1200, 1), Buffer.alloc(1400, 2)].map((b) => new Uint8Array(b))
    const encoded = encodeResponse({ version: RDCLEANPATH_VERSION, serverCertChain: chain })
    expect(pduLength(encoded)).toBe(encoded.length)
  })
})
