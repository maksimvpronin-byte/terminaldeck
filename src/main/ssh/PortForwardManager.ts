import net, { type Server, type Socket } from 'net'
import type { Client } from 'ssh2'
import { sshManager } from './SSHManager'
import {
  HANDSHAKE_LIMIT,
  HANDSHAKE_TIMEOUT,
  parseGreeting,
  parseRequest,
  reply,
  SOCKS5_FAILED,
  SOCKS5_GRANTED
} from './socks5'
import type { PortForwardRule } from '../../shared/types'

interface ActiveForward {
  rule: PortForwardRule
  /**
   * Opening until the listener is up. A forward is registered the moment it is
   * asked for, not once it is open: anything that stops it in between — Stop,
   * a disconnect, a reload — has to be able to find it.
   */
  state: 'opening' | 'active'
  stopped: boolean
  server?: Server
  cleanupRemote?: () => void
  /** Connections carried by this forward, closed with it. */
  sockets: Set<Socket>
}

function targetClient(connectionId: string): Client {
  const chain = sshManager.getClientChain(connectionId)
  if (!chain || chain.length === 0) throw new Error('No active SSH connection')
  return chain[chain.length - 1]
}

function pipeStreams(a: NodeJS.ReadWriteStream, b: NodeJS.ReadWriteStream): void {
  a.pipe(b)
  b.pipe(a)
  const cleanup = (): void => {
    a.unpipe(b)
    b.unpipe(a)
  }
  a.on('close', cleanup)
  b.on('close', cleanup)
  a.on('error', cleanup)
  b.on('error', cleanup)
}

/**
 * A SOCKS5 handshake, read the way a stream has to be read.
 *
 * Nothing here assumes that a message arrives in one piece: bytes are collected
 * until a parser says it has a whole one, and whatever follows the request is
 * handed to the tunnel rather than dropped. See `socks5.ts` for why both halves
 * of that matter — the first cost the main process an uncaught `RangeError`,
 * and the second silently swallowed the first thing a pipelining client said.
 */
function handleSocks5(socket: Socket, client: Client): void {
  // Annotated: `alloc` yields a buffer tied to its own ArrayBuffer, while the
  // slices a parser hands back are views onto another, and the two disagree.
  let buf: Buffer = Buffer.alloc(0)
  let stage: 'greeting' | 'request' | 'done' = 'greeting'

  /** A handshake that never finishes must not hold the socket for ever. */
  const timer = setTimeout(() => {
    if (stage !== 'done') socket.destroy()
  }, HANDSHAKE_TIMEOUT)
  timer.unref?.()

  const give_up = (): void => {
    clearTimeout(timer)
    socket.destroy()
  }

  const onData = (chunk: Buffer): void => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    if (buf.length > HANDSHAKE_LIMIT) {
      give_up()
      return
    }

    if (stage === 'greeting') {
      const greeting = parseGreeting(buf)
      if (greeting.status === 'incomplete') return
      if (greeting.status === 'invalid') {
        give_up()
        return
      }
      socket.write(Buffer.from([0x05, 0x00])) // no-auth accepted
      buf = greeting.rest
      stage = 'request'
      // The request may already be in hand: a client is free to send it without
      // waiting for the reply, and some do.
      if (buf.length === 0) return
    }

    const request = parseRequest(buf)
    if (request.status === 'incomplete') return
    if (request.status === 'invalid') {
      give_up()
      return
    }

    stage = 'done'
    clearTimeout(timer)
    socket.removeListener('data', onData)
    /*
     * Paused until the tunnel exists. Between here and the callback below the
     * socket has no reader at all, and anything it emitted in that gap would go
     * nowhere — which is the same lost-bytes fault as dropping `rest`, only
     * harder to see.
     */
    socket.pause()
    const leftover = request.rest

    client.forwardOut('127.0.0.1', 0, request.address, request.port, (err, stream) => {
      if (err) {
        socket.write(reply(SOCKS5_FAILED))
        socket.destroy()
        return
      }
      socket.write(reply(SOCKS5_GRANTED))
      const tunnel = stream as unknown as NodeJS.ReadWriteStream
      if (leftover.length > 0) tunnel.write(leftover)
      pipeStreams(socket, tunnel)
      socket.resume()
    })
  }

  socket.on('data', onData)
  socket.on('error', () => clearTimeout(timer))
  socket.on('close', () => clearTimeout(timer))
}

class PortForwardManager {
  private active = new Map<string, ActiveForward>()
  /** A start still in progress, shared by anyone who asks for the same rule. */
  private opening = new Map<string, Promise<void>>()

  /**
   * Opens a forward, unless it is stopped first.
   *
   * A forward used to be recorded only once its listener was up. Stopping it, or
   * losing the connection, before that point found nothing to stop — and the
   * listener then came up anyway, bound to its port with no connection behind
   * it and listed as active. Now it is recorded as opening straight away, and a
   * listener that finishes opening after it was stopped is closed on arrival.
   */
  start(connectionId: string, rule: PortForwardRule): Promise<void> {
    const key = `${connectionId}:${rule.id}`
    const inProgress = this.opening.get(key)
    if (inProgress) return inProgress
    if (this.active.has(key)) return Promise.resolve()

    const client = targetClient(connectionId)
    const entry: ActiveForward = { rule, state: 'opening', stopped: false, sockets: new Set() }
    this.active.set(key, entry)
    const opening = this.open(client, entry)
      .then(() => {
        if (entry.stopped) throw new Error(`The forward ${rule.id} was stopped before it opened`)
        entry.state = 'active'
      })
      .catch((err) => {
        this.release(entry)
        if (this.active.get(key) === entry) this.active.delete(key)
        throw err
      })
      .finally(() => this.opening.delete(key))
    this.opening.set(key, opening)
    return opening
  }

  private track(entry: ActiveForward, socket: Socket): void {
    if (entry.stopped) {
      socket.destroy()
      return
    }
    entry.sockets.add(socket)
    socket.on('close', () => entry.sockets.delete(socket))
  }

  private async open(client: Client, entry: ActiveForward): Promise<void> {
    const { rule } = entry
    if (rule.type === 'local' || rule.type === 'dynamic') {
      const server = net.createServer((socket) => {
        this.track(entry, socket)
        if (rule.type === 'dynamic') {
          handleSocks5(socket, client)
          return
        }
        client.forwardOut(
          rule.srcHost,
          rule.srcPort,
          rule.dstHost ?? '127.0.0.1',
          rule.dstPort ?? 0,
          (err, stream) => {
            if (err) {
              socket.destroy()
              return
            }
            pipeStreams(socket, stream as unknown as NodeJS.ReadWriteStream)
          }
        )
      })
      entry.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(rule.srcPort, rule.srcHost, () => resolve())
      })
      return
    }

    // remote forward: ask the SSH server to listen and forward back to us
    await new Promise<void>((resolve, reject) => {
      client.forwardIn(rule.srcHost, rule.srcPort, (err) => (err ? reject(err) : resolve()))
    })
    const onTcpConnection = (
      info: { destIP: string; destPort: number },
      accept: () => NodeJS.ReadWriteStream,
      reject: () => void
    ): void => {
      /**
       * Only connections for this rule's port.
       *
       * `tcp connection` is emitted on the connection, not on the forward, so
       * every rule's handler hears about every rule's traffic. Ignoring which
       * port it arrived on meant two remote forwards over one host each
       * accepted the other's connections — both handlers ran, both called
       * `accept`, and whichever won sent the caller to the wrong place. With
       * one rule it looked perfectly correct, which is why it survived.
       */
      if (info.destPort !== rule.srcPort) return

      const socket = net.connect(rule.dstPort ?? 0, rule.dstHost ?? '127.0.0.1')
      this.track(entry, socket)
      socket.on('error', () => reject())
      socket.on('connect', () => {
        const stream = accept()
        pipeStreams(socket, stream)
      })
    }
    client.on('tcp connection', onTcpConnection)
    entry.cleanupRemote = () => {
      client.unforwardIn(rule.srcHost, rule.srcPort, () => undefined)
      client.removeListener('tcp connection', onTcpConnection)
    }
    // Stopped while the server was still agreeing: undo it now it has.
    if (entry.stopped) this.release(entry)
  }

  /**
   * Closes whatever a forward holds. Stop means stop: the connections it is
   * carrying close too, rather than living on through a forward the list says
   * is gone.
   */
  private release(entry: ActiveForward): void {
    entry.server?.close()
    entry.cleanupRemote?.()
    entry.cleanupRemote = undefined
    for (const socket of entry.sockets) socket.destroy()
    entry.sockets.clear()
  }

  stop(connectionId: string, ruleId: string): void {
    const key = `${connectionId}:${ruleId}`
    const fwd = this.active.get(key)
    if (!fwd) return
    fwd.stopped = true
    this.release(fwd)
    this.active.delete(key)
  }

  stopAllForConnection(connectionId: string): void {
    for (const key of [...this.active.keys()]) {
      if (key.startsWith(`${connectionId}:`)) {
        this.stop(connectionId, key.slice(connectionId.length + 1))
      }
    }
  }

  listActive(connectionId: string): string[] {
    return [...this.active.entries()]
      .filter(([k, fwd]) => k.startsWith(`${connectionId}:`) && fwd.state === 'active')
      .map(([k]) => k.slice(connectionId.length + 1))
  }
}

export const portForwardManager = new PortForwardManager()
