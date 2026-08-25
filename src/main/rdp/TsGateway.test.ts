import { describe, it, expect } from 'vitest'
import { Duplex, PassThrough } from 'stream'
import { Tunnel, websocketWire, chunkedWire } from './TsGateway'
import {
  HEADER_LENGTH,
  PacketReader,
  PacketType,
  dataPacket,
  parseDataPacket,
  readHeader
} from '../../shared/tsgu'
import { FrameReader, Opcode, encodeFrame } from '../../shared/wsframe'
import { ChunkReader, encodeChunk } from '../../shared/httpChunks'

/**
 * A gateway that answers whatever the tunnel asks, over a pair of streams.
 *
 * The handshake is four exchanges in a fixed order, each of which can refuse.
 * Getting that order or an error path wrong is not something a unit test of the
 * packet encoding would catch, and a real gateway is not available to a test.
 */
class FakeGateway {
  readonly wire: Duplex
  /** Packet types the client sent, in order. */
  readonly asked: number[] = []
  private toClient = new PassThrough()
  private frames = new FrameReader()
  /** Error code to answer each step with; zero is success. */
  errors: Record<number, number> = {}
  /** Extra body bytes to append to a response, for optional fields. */
  extras: Record<number, number[]> = {}
  /** Steps to receive but not answer, so a test can supply the answer itself. */
  silentFor = new Set<number>()

  constructor() {
    const fromClient = new PassThrough()
    fromClient.on('data', (chunk: Buffer) => this.onData(chunk))
    this.wire = Duplex.from({ writable: fromClient, readable: this.toClient })
  }

  private onData(chunk: Buffer): void {
    for (const frame of this.frames.push(chunk)) {
      if (frame.opcode !== Opcode.Binary) continue
      const header = readHeader(frame.payload)
      if (!header) continue
      this.asked.push(header.type)

      if (header.type === PacketType.Data) {
        // Echo, so a test can watch a payload make the round trip.
        this.send(dataPacket(parseDataPacket(frame.payload)))
        continue
      }
      if (this.silentFor.has(header.type)) continue
      const answer = this.answerTo(header.type)
      if (answer) this.send(answer)
    }
  }

  private answerTo(type: number): Uint8Array | null {
    const error = this.errors[type] ?? 0
    const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
    const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff]

    switch (type) {
      case PacketType.HandshakeRequest:
        return build(PacketType.HandshakeResponse, [...le32(error), 1, 0, ...le16(6), ...le16(0)])
      case PacketType.TunnelCreate:
        return build(PacketType.TunnelResponse, [
          ...le16(6),
          ...le32(error),
          ...le16(0),
          ...le16(0),
          ...(this.extras[type] ?? [])
        ])
      case PacketType.TunnelAuth:
        return build(PacketType.TunnelAuthResponse, [...le32(error), ...le16(0), ...le16(0)])
      case PacketType.ChannelCreate:
        return build(PacketType.ChannelResponse, [...le32(error), ...le16(0), ...le16(0)])
      default:
        return null
    }
  }

  send(packet: Uint8Array): void {
    this.toClient.write(Buffer.from(encodeFrame(Opcode.Binary, packet, new Uint8Array(4))))
  }
}

function build(type: PacketType, body: number[]): Uint8Array {
  const out = new Uint8Array(HEADER_LENGTH + body.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, type, true)
  view.setUint32(4, out.length, true)
  out.set(body, HEADER_LENGTH)
  return out
}

const silent = (): void => {}

describe('Tunnel', () => {
  it('opens a channel through the four exchanges, in order', async () => {
    const gateway = new FakeGateway()
    const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)

    await tunnel.open({ host: 'pc.example.com', port: 3389 })

    expect(gateway.asked).toEqual([
      PacketType.HandshakeRequest,
      PacketType.TunnelCreate,
      PacketType.TunnelAuth,
      PacketType.ChannelCreate
    ])
  })

  it('carries bytes once the channel is open', async () => {
    const gateway = new FakeGateway()
    const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)
    await tunnel.open({ host: 'pc', port: 3389 })

    const arrived = new Promise<Buffer>((resolve) => tunnel.once('data', resolve))
    tunnel.write(Buffer.from([3, 0, 0, 19]))
    expect(Array.from(await arrived)).toEqual([3, 0, 0, 19])
  })

  it('does not deliver data before the channel is open', async () => {
    const gateway = new FakeGateway()
    const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)

    let leaked = false
    tunnel.on('data', () => (leaked = true))
    // A data packet arriving mid-handshake belongs to nothing yet.
    gateway.send(dataPacket(new Uint8Array([1, 2, 3])))
    await tunnel.open({ host: 'pc', port: 3389 })
    expect(leaked).toBe(false)
  })

  it('reports which step the gateway refused, and why', async () => {
    const cases: Array<[number, RegExp]> = [
      [PacketType.HandshakeRequest, /refused the handshake/],
      [PacketType.TunnelCreate, /would not open a tunnel/],
      [PacketType.TunnelAuth, /would not authorise the tunnel/],
      [PacketType.ChannelCreate, /could not reach pc/]
    ]
    for (const [step, message] of cases) {
      const gateway = new FakeGateway()
      gateway.errors[step] = 0x800759da // the connection policy refusal
      const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)
      await expect(tunnel.open({ host: 'pc', port: 3389 })).rejects.toThrow(message)
      // And the reason, which is the half a person can act on.
      await expect(tunnel.open({ host: 'pc', port: 3389 })).rejects.toThrow(/connection policy/)
    }
  })

  it('keeps a packet that arrives before anything is waiting for it', async () => {
    // Two ways this happens: bytes carried over from the HTTP upgrade in the
    // same TCP segment, and an answer landing between two steps of the
    // handshake. Both are packets with no waiter yet, and dropping either
    // leaves the tunnel waiting for something it has already been given.
    const gateway = new FakeGateway()
    gateway.silentFor.add(PacketType.HandshakeRequest)
    const early = Buffer.from(
      encodeFrame(
        Opcode.Binary,
        build(PacketType.HandshakeResponse, [0, 0, 0, 0, 1, 0, 6, 0, 0, 0]),
        new Uint8Array(4)
      )
    )

    const tunnel = new Tunnel(websocketWire(gateway.wire, early), silent)
    await tunnel.open({ host: 'pc', port: 3389 })
    expect(gateway.asked).toContain(PacketType.ChannelCreate)
  })

  it('splits a write too large for one packet', async () => {
    const gateway = new FakeGateway()
    const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)
    await tunnel.open({ host: 'pc', port: 3389 })

    const chunks: number[] = []
    tunnel.on('data', (chunk: Buffer) => chunks.push(chunk.length))
    tunnel.write(Buffer.alloc(70000))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 0xffff then the remainder, because a packet states its length in 16 bits.
    expect(chunks).toEqual([0xffff, 70000 - 0xffff])
  })

  it('answers a ping so the gateway does not time the connection out', async () => {
    const gateway = new FakeGateway()
    const tunnel = new Tunnel(websocketWire(gateway.wire, new Uint8Array(0)), silent)
    await tunnel.open({ host: 'pc', port: 3389 })

    const before = gateway.asked.length
    gateway.wire.push(Buffer.from(encodeFrame(Opcode.Ping, new Uint8Array([1]), new Uint8Array(4))))
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The pong is not a tunnel packet, so nothing new was asked of the gateway.
    expect(gateway.asked.length).toBe(before)
  })
})


/**
 * The older transport, where the two directions are two connections and every
 * packet is one HTTP chunk. Modelled with streams rather than sockets: what is
 * worth testing is the framing and the seed payload, neither of which involves
 * TLS.
 */
class FakeLegacyGateway {
  /** What the tunnel reads from — the gateway's endless response body. */
  readonly incoming = new PassThrough()
  /** What the tunnel writes into — the endless request body. */
  readonly outgoing = new PassThrough()
  readonly asked: number[] = []
  /** Steps to receive but not answer, so a test can supply the answer itself. */
  readonly silentFor = new Set<number>()
  private chunks = new ChunkReader()
  private packets = new PacketReader()

  constructor() {
    this.outgoing.on('data', (chunk: Buffer) => {
      for (const payload of this.chunks.push(chunk)) {
        for (const packet of this.packets.push(payload)) {
          const header = readHeader(packet)
          if (!header) continue
          this.asked.push(header.type)
          if (this.silentFor.has(header.type)) continue
          const answer = answerTo(header.type, packet)
          if (answer) this.say(answer)
        }
      }
    })
  }

  /** Sends bytes the way the gateway does: inside a chunk. */
  say(bytes: Uint8Array): void {
    this.incoming.write(Buffer.from(encodeChunk(bytes)))
  }
}

function answerTo(type: number, packet: Uint8Array): Uint8Array | null {
  const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
  const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff]
  switch (type) {
    case PacketType.HandshakeRequest:
      return build(PacketType.HandshakeResponse, [...le32(0), 1, 0, ...le16(6), ...le16(0)])
    case PacketType.TunnelCreate:
      return build(PacketType.TunnelResponse, [...le16(6), ...le32(0), ...le16(0), ...le16(0)])
    case PacketType.TunnelAuth:
      return build(PacketType.TunnelAuthResponse, [...le32(0), ...le16(0), ...le16(0)])
    case PacketType.ChannelCreate:
      return build(PacketType.ChannelResponse, [...le32(0), ...le16(0), ...le16(0)])
    case PacketType.Data:
      return build(PacketType.Data, [...le16(packet.length - 10), ...packet.subarray(10)])
    default:
      return null
  }
}

describe('the older transport', () => {
  /** The wire under test, with the seed the gateway sends before anything else. */
  function wireFor(gateway: FakeLegacyGateway, seed = 10): ReturnType<typeof chunkedWire> {
    return chunkedWire(
      gateway.incoming as unknown as never,
      gateway.outgoing as unknown as never,
      new Uint8Array(0),
      { chunked: true, discardFirst: seed }
    )
  }

  it('opens a channel with every packet inside a chunk', async () => {
    const gateway = new FakeLegacyGateway()
    const tunnel = new Tunnel(wireFor(gateway), silent)
    // The random bytes [MS-TSGU] has the gateway send first.
    gateway.say(Buffer.alloc(10, 0xab))

    await tunnel.open({ host: 'pc.example.com', port: 3389 })
    expect(gateway.asked).toEqual([
      PacketType.HandshakeRequest,
      PacketType.TunnelCreate,
      PacketType.TunnelAuth,
      PacketType.ChannelCreate
    ])
  })

  it('drops the seed payload rather than reading it as a packet', async () => {
    const gateway = new FakeLegacyGateway()
    gateway.silentFor.add(PacketType.HandshakeRequest)
    const tunnel = new Tunnel(wireFor(gateway), silent)

    // Seed and the first real answer in one chunk, which is what a gateway that
    // answers quickly produces. Without the seed being dropped, the packet
    // reader would take the random bytes for a header and give up.
    gateway.say(
      Buffer.concat([
        Buffer.alloc(10, 0xab),
        Buffer.from(build(PacketType.HandshakeResponse, [0, 0, 0, 0, 1, 0, 6, 0, 0, 0]))
      ])
    )
    await tunnel.open({ host: 'pc', port: 3389 })
    expect(gateway.asked).toContain(PacketType.ChannelCreate)
  })

  it('carries bytes once the channel is open', async () => {
    const gateway = new FakeLegacyGateway()
    const tunnel = new Tunnel(wireFor(gateway), silent)
    gateway.say(Buffer.alloc(10, 0xab))
    await tunnel.open({ host: 'pc', port: 3389 })

    const arrived = new Promise<Buffer>((resolve) => tunnel.once('data', resolve))
    tunnel.write(Buffer.from([3, 0, 0, 19]))
    expect(Array.from(await arrived)).toEqual([3, 0, 0, 19])
  })

  it('reassembles a packet split across two chunks', async () => {
    const gateway = new FakeLegacyGateway()
    gateway.silentFor.add(PacketType.HandshakeRequest)
    const tunnel = new Tunnel(wireFor(gateway), silent)
    gateway.say(Buffer.alloc(10, 0xab))

    // A chunk boundary has nothing to do with a packet boundary.
    const response = Buffer.from(build(PacketType.HandshakeResponse, [0, 0, 0, 0, 1, 0, 6, 0, 0, 0]))
    gateway.say(response.subarray(0, 5))
    gateway.say(response.subarray(5))

    await tunnel.open({ host: 'pc', port: 3389 })
    expect(gateway.asked).toContain(PacketType.ChannelCreate)
  })
})
