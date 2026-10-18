import { describe, it, expect, vi } from 'vitest'
import net from 'net'
import { Duplex } from 'stream'
import type { Client } from 'ssh2'

/**
 * A tunnel over real sockets, for the one thing a stand-in socket cannot show:
 * a program that says it has finished sending and then waits for the answer.
 *
 * The sockets were made the ordinary way, which closes a socket's own sending
 * side as soon as the other end has finished. The answer then had nowhere to
 * go, and the program got an empty reply from any service that answers only
 * after the end of the question.
 */

/** A channel that answers once the question has ended, the way such a service does. */
function answeringChannel(): Duplex {
  let question = ''
  const channel: Duplex = new Duplex({
    read: () => undefined,
    write: (chunk: Buffer, _encoding, cb) => {
      question += chunk.toString()
      cb()
    },
    final: (cb) => {
      cb()
      setImmediate(() => {
        channel.push(`answer to ${question}`)
        channel.push(null)
      })
    }
  })
  return channel
}

const client = {
  forwardOut: (
    _srcHost: string,
    _srcPort: number,
    _dstHost: string,
    _dstPort: number,
    cb: (err: Error | undefined, stream: Duplex) => void
  ) => cb(undefined, answeringChannel())
} as unknown as Client
vi.mock('./SSHManager', () => ({ sshManager: { getClientChain: () => [client] } }))

const { portForwardManager } = await import('./PortForwardManager')

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as net.AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

describe('a tunnel and a program that finishes sending before it reads', () => {
  it('brings the answer back after the program has ended its side', async () => {
    const port = await freePort()
    await portForwardManager.start('half', {
      id: 'half-rule',
      type: 'local',
      srcHost: '127.0.0.1',
      srcPort: port,
      dstHost: 'service',
      dstPort: 7
    })
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
        let got = ''
        socket.on('data', (chunk) => (got += chunk.toString()))
        socket.on('end', () => resolve(got))
        socket.on('error', reject)
        socket.end('question')
      })
      expect(reply).toBe('answer to question')
    } finally {
      portForwardManager.stopAllForConnection('half')
    }
  })
})
