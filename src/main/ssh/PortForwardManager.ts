import net, { type Server, type Socket } from 'net'
import type { Client } from 'ssh2'
import type { Duplex } from 'stream'
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

/** A remote forward the server has agreed to, as incoming connections are matched against. */
interface RemoteRoute {
  entry: ActiveForward
  bindHost: string
  /** The port the server listens on: the rule's, or the one it chose for port 0. */
  port: number
}

function targetClient(connectionId: string): Client {
  const chain = sshManager.getClientChain(connectionId)
  if (!chain || chain.length === 0) throw new Error('No active SSH connection')
  return chain[chain.length - 1]
}

/**
 * Joins a local socket and an SSH channel, and ends them together.
 *
 * Closing one side used only to unpipe it from the other, which stayed open:
 * a tunnel stopped, or a local program that went away, left its SSH channel
 * open on the server until something else happened to close it.
 *
 * A side that ends properly is left to the pipe, which ends the other once
 * everything it had to say has been written — destroying it then would drop
 * the last of a reply still on its way. A side that closes without ending —
 * destroyed by Stop, reset, or failed — takes the other down with it.
 */
export function pipeStreams(a: Duplex, b: Duplex): void {
  a.pipe(b)
  b.pipe(a)
  let done = false
  const tearDown = (): void => {
    if (done) return
    done = true
    a.unpipe(b)
    b.unpipe(a)
    a.destroy()
    b.destroy()
  }
  a.on('close', () => {
    if (!b.writableEnded) tearDown()
  })
  b.on('close', () => {
    if (!a.writableEnded) tearDown()
  })
  a.on('error', tearDown)
  b.on('error', tearDown)
}

/** A channel that opened for a socket already gone: nothing is left to carry. */
function discard(stream: Duplex): void {
  stream.destroy()
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
        if (socket.destroyed) return
        socket.write(reply(SOCKS5_FAILED))
        socket.destroy()
        return
      }
      if (socket.destroyed) {
        discard(stream as unknown as Duplex)
        return
      }
      socket.write(reply(SOCKS5_GRANTED))
      const tunnel = stream as unknown as Duplex
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
   * The remote forwards on each connection, and the one listener that sends
   * each incoming connection to its own.
   *
   * `tcp connection` is emitted on the client, not on a forward. Each forward
   * used to listen for itself and pick out its port, so two forwards on one
   * port but different addresses both took the same connection — each opened a
   * socket to its own destination and both called `accept`.
   */
  private remote = new Map<
    Client,
    {
      routes: Set<RemoteRoute>
      listener: (
        info: { destIP: string; destPort: number },
        accept: () => NodeJS.ReadWriteStream,
        reject: () => void
      ) => void
    }
  >()

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
            if (socket.destroyed) {
              discard(stream as unknown as Duplex)
              return
            }
            pipeStreams(socket, stream as unknown as Duplex)
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
    /*
     * The port the server really listens on. For port 0 it chooses one, and
     * that is the port connections then arrive on and the one to stop: the
     * rule's 0 matched nothing, and stopping asked the server to close port 0.
     */
    const port = await new Promise<number>((resolve, reject) => {
      client.forwardIn(rule.srcHost, rule.srcPort, (err, bound) =>
        err ? reject(err) : resolve(bound || rule.srcPort)
      )
    })
    const route: RemoteRoute = { entry, bindHost: rule.srcHost, port }
    this.addRoute(client, route)
    entry.cleanupRemote = () => {
      client.unforwardIn(rule.srcHost, port, () => undefined)
      this.removeRoute(client, route)
    }
    // Stopped while the server was still agreeing: undo it now it has.
    if (entry.stopped) this.release(entry)
  }

  private addRoute(client: Client, route: RemoteRoute): void {
    let forwards = this.remote.get(client)
    if (!forwards) {
      const routes = new Set<RemoteRoute>()
      const listener = (
        info: { destIP: string; destPort: number },
        accept: () => NodeJS.ReadWriteStream,
        reject: () => void
      ): void => {
        // ssh2 announces only connections for an address and port it was asked
        // to forward, in the same words — so the match is exact.
        const match = [...routes].find(
          (r) => r.port === info.destPort && r.bindHost === info.destIP
        )
        if (!match) return reject()
        this.carryIncoming(match.entry, accept, reject)
      }
      forwards = { routes, listener }
      this.remote.set(client, forwards)
      client.on('tcp connection', listener)
    }
    forwards.routes.add(route)
  }

  private removeRoute(client: Client, route: RemoteRoute): void {
    const forwards = this.remote.get(client)
    if (!forwards) return
    forwards.routes.delete(route)
    if (forwards.routes.size > 0) return
    client.removeListener('tcp connection', forwards.listener)
    this.remote.delete(client)
  }

  /** One connection that arrived through a remote forward, taken to its destination. */
  private carryIncoming(
    entry: ActiveForward,
    accept: () => NodeJS.ReadWriteStream,
    reject: () => void
  ): void {
    const { rule } = entry
    let answered = false
    const refuse = (): void => {
      if (answered) return
      answered = true
      reject()
    }
    const socket = net.connect(rule.dstPort ?? 0, rule.dstHost ?? '127.0.0.1')
    this.track(entry, socket)
    socket.on('error', refuse)
    // Destroyed before it connected — the forward stopped — says only 'close'.
    // The server is still waiting for an answer, and is given one.
    socket.on('close', refuse)
    socket.on('connect', () => {
      if (answered || socket.destroyed) return
      answered = true
      pipeStreams(socket, accept() as Duplex)
    })
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
