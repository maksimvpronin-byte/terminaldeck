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
  server?: Server
  cleanupRemote?: () => void
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

  async start(connectionId: string, rule: PortForwardRule): Promise<void> {
    const client = targetClient(connectionId)
    const key = `${connectionId}:${rule.id}`
    if (this.active.has(key)) return

    if (rule.type === 'local') {
      const server = net.createServer((socket) => {
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
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(rule.srcPort, rule.srcHost, () => resolve())
      })
      this.active.set(key, { rule, server })
      return
    }

    if (rule.type === 'dynamic') {
      const server = net.createServer((socket) => handleSocks5(socket, client))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(rule.srcPort, rule.srcHost, () => resolve())
      })
      this.active.set(key, { rule, server })
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
      socket.on('error', () => reject())
      socket.on('connect', () => {
        const stream = accept()
        pipeStreams(socket, stream)
      })
    }
    client.on('tcp connection', onTcpConnection)
    this.active.set(key, {
      rule,
      cleanupRemote: () => {
        client.unforwardIn(rule.srcHost, rule.srcPort, () => undefined)
        client.removeListener('tcp connection', onTcpConnection)
      }
    })
  }

  stop(connectionId: string, ruleId: string): void {
    const key = `${connectionId}:${ruleId}`
    const fwd = this.active.get(key)
    if (!fwd) return
    fwd.server?.close()
    fwd.cleanupRemote?.()
    this.active.delete(key)
  }

  stopAllForConnection(connectionId: string): void {
    for (const key of this.active.keys()) {
      if (key.startsWith(`${connectionId}:`)) {
        const [, ruleId] = key.split(':')
        this.stop(connectionId, ruleId)
      }
    }
  }

  listActive(connectionId: string): string[] {
    return [...this.active.keys()]
      .filter((k) => k.startsWith(`${connectionId}:`))
      .map((k) => k.split(':')[1])
  }
}

export const portForwardManager = new PortForwardManager()
