import net, { type Server, type Socket } from 'net'
import type { Client } from 'ssh2'
import { sshManager } from './SSHManager'
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

/** Minimal SOCKS5 handshake (no-auth) sufficient for a dynamic port forward. */
function handleSocks5(socket: Socket, client: Client): void {
  let stage: 'greeting' | 'request' = 'greeting'

  socket.once('data', function onGreeting(data: Buffer) {
    if (data[0] !== 0x05) {
      socket.destroy()
      return
    }
    socket.write(Buffer.from([0x05, 0x00])) // no-auth accepted
    stage = 'request'
    socket.once('data', onRequest)
  })

  function onRequest(data: Buffer): void {
    if (stage !== 'request' || data[0] !== 0x05 || data[1] !== 0x01) {
      socket.destroy()
      return
    }
    const atyp = data[3]
    let addr = ''
    let offset = 4
    if (atyp === 0x01) {
      addr = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
      offset = 8
    } else if (atyp === 0x03) {
      const len = data[4]
      addr = data.subarray(5, 5 + len).toString('ascii')
      offset = 5 + len
    } else if (atyp === 0x04) {
      const parts: string[] = []
      for (let i = 0; i < 16; i += 2) parts.push(data.readUInt16BE(4 + i).toString(16))
      addr = parts.join(':')
      offset = 20
    } else {
      socket.destroy()
      return
    }
    const port = data.readUInt16BE(offset)

    client.forwardOut('127.0.0.1', 0, addr, port, (err, stream) => {
      if (err) {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.destroy()
        return
      }
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      pipeStreams(socket, stream as unknown as NodeJS.ReadWriteStream)
    })
  }
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
