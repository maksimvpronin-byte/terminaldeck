import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
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

const client = new EventEmitter() as unknown as Client
vi.mock('./SSHManager', () => ({ sshManager: { getClientChain: () => [client] } }))

const { portForwardManager } = await import('./PortForwardManager')

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
