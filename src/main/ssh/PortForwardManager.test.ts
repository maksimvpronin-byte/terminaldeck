import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Duplex, PassThrough } from 'stream'
import type { Client } from 'ssh2'

/**
 * A forward stopped while it is still opening. It used to be recorded only once
 * open, so a stop in that moment found nothing, and the listener came up anyway
 * with no connection behind it.
 */

let finishListen: () => void = () => undefined
const closed: string[] = []

vi.mock('net', () => {
  const createServer = (): EventEmitter & { listen: unknown; close: unknown } =>
    Object.assign(new EventEmitter(), {
      listen: (_port: number, _host: string, done: () => void) => {
        finishListen = done
      },
      close: () => closed.push('server')
    })
  return { default: { createServer, connect: vi.fn() }, createServer }
})

/** What the server was asked to listen on, and what it was asked to stop. */
const forwardedIn: Array<[string, number]> = []
const unforwarded: Array<[string, number]> = []
/** The port the server says it chose when asked for 0. */
const CHOSEN_PORT = 40001
const client = Object.assign(new EventEmitter(), {
  forwardIn: (host: string, port: number, cb: (err: Error | null, bound: number) => void) => {
    forwardedIn.push([host, port])
    cb(null, port === 0 ? CHOSEN_PORT : port)
  },
  unforwardIn: (host: string, port: number, cb: () => void) => {
    unforwarded.push([host, port])
    cb()
  }
}) as unknown as Client
vi.mock('./SSHManager', () => ({ sshManager: { getClientChain: () => [client] } }))

const { portForwardManager, pipeStreams } = await import('./PortForwardManager')
const net = (await import('net')).default

const rule = {
  id: 'rule-1',
  type: 'local' as const,
  srcHost: '127.0.0.1',
  srcPort: 15432,
  dstHost: 'db',
  dstPort: 5432
}

describe('a tunnel stopped while it opens', () => {
  it('closes the listener that comes up afterwards and never lists it', async () => {
    const opening = portForwardManager.start('conn', rule)
    expect(portForwardManager.listActive('conn')).toEqual([])

    portForwardManager.stopAllForConnection('conn')
    finishListen()

    await expect(opening).rejects.toThrow(/stopped before it opened/)
    expect(closed).toContain('server')
    expect(portForwardManager.listActive('conn')).toEqual([])
  })

  it('shares one opening between two starts of the same rule', async () => {
    const first = portForwardManager.start('conn2', rule)
    const second = portForwardManager.start('conn2', rule)
    expect(second).toBe(first)
    finishListen()
    await first
    expect(portForwardManager.listActive('conn2')).toEqual(['rule-1'])
    portForwardManager.stop('conn2', 'rule-1')
  })
})

/**
 * Remote forwards. `tcp connection` is emitted on the client for all of them,
 * and each forward used to pick out its own by port alone.
 */
describe('connections arriving through remote forwards', () => {
  function remoteRule(id: string, srcHost: string, srcPort: number, dstHost: string) {
    return { id, type: 'remote' as const, srcHost, srcPort, dstHost, dstPort: 80 }
  }
  /** A socket that connects when told to; a PassThrough, so it can be piped. */
  function fakeSockets(): PassThrough[] {
    const made: PassThrough[] = []
    vi.mocked(net.connect).mockImplementation((() => {
      const socket = new PassThrough()
      made.push(socket)
      return socket
    }) as never)
    return made
  }
  function arrive(destIP: string, destPort: number) {
    const accept = vi.fn(() => new PassThrough())
    const reject = vi.fn()
    client.emit('tcp connection', { destIP, destPort }, accept, reject)
    return { accept, reject }
  }

  it('sends a connection only to the forward for its address, not every one on its port', async () => {
    const sockets = fakeSockets()
    await portForwardManager.start('r1', remoteRule('a', '10.0.0.1', 8080, 'app-a'))
    await portForwardManager.start('r1', remoteRule('b', '10.0.0.2', 8080, 'app-b'))

    const { accept } = arrive('10.0.0.2', 8080)
    expect(vi.mocked(net.connect).mock.calls).toEqual([[80, 'app-b']])
    sockets[0].emit('connect')
    expect(accept).toHaveBeenCalledTimes(1)

    portForwardManager.stopAllForConnection('r1')
    vi.mocked(net.connect).mockReset()
  })

  it('uses the port the server chose for port 0, to carry and to stop', async () => {
    fakeSockets()
    await portForwardManager.start('r2', remoteRule('any', '0.0.0.0', 0, 'app'))
    expect(forwardedIn).toContainEqual(['0.0.0.0', 0])

    arrive('0.0.0.0', CHOSEN_PORT)
    expect(net.connect).toHaveBeenCalledTimes(1)

    portForwardManager.stop('r2', 'any')
    expect(unforwarded).toContainEqual(['0.0.0.0', CHOSEN_PORT])
    vi.mocked(net.connect).mockReset()
  })

  it('refuses a connection that arrives for nothing it forwards', async () => {
    fakeSockets()
    await portForwardManager.start('r3', remoteRule('a', '127.0.0.1', 9000, 'app'))
    const { accept, reject } = arrive('127.0.0.1', 9001)
    expect(reject).toHaveBeenCalledTimes(1)
    expect(accept).not.toHaveBeenCalled()
    portForwardManager.stopAllForConnection('r3')
    vi.mocked(net.connect).mockReset()
  })

  /** The server waits for an answer to every connection it announces. */
  it('answers the server when the forward stops before the local end connects', async () => {
    fakeSockets()
    await portForwardManager.start('r4', remoteRule('a', '127.0.0.1', 9100, 'app'))
    const { accept, reject } = arrive('127.0.0.1', 9100)

    portForwardManager.stop('r4', 'a')
    await new Promise((resolve) => setImmediate(resolve))

    expect(reject).toHaveBeenCalledTimes(1)
    expect(accept).not.toHaveBeenCalled()
    vi.mocked(net.connect).mockReset()
  })
})

/**
 * Closing one side of a tunnel only unpiped it, so a Stop that destroyed the
 * local socket left the SSH channel open on the server.
 */
describe('the two ends of one tunnelled connection', () => {
  /** One end: what is written to it is kept, what it reads is pushed by the test. */
  function end(): Duplex & { written: string } {
    const d = Object.assign(
      new Duplex({
        read: () => undefined,
        write: (chunk: Buffer, _encoding, cb) => {
          d.written += chunk.toString()
          cb()
        }
      }),
      { written: '' }
    )
    return d
  }
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

  it('closes the channel when the socket is destroyed', async () => {
    const socket = end()
    const channel = end()
    pipeStreams(socket, channel)

    socket.destroy()
    await settle()

    expect(channel.destroyed).toBe(true)
  })

  it('lets the other side finish writing when one ends properly', async () => {
    const socket = end()
    const channel = end()
    pipeStreams(socket, channel)

    socket.push('last words')
    socket.push(null)
    socket.end()
    await settle()

    expect(channel.written).toBe('last words')
    expect(channel.writableEnded).toBe(true)
    expect(channel.destroyed).toBe(false)
  })
})
