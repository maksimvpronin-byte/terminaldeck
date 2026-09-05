import { it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { Client, ClientChannel } from 'ssh2'
import { executeDiagnostic } from './execute'

afterEach(() => vi.useRealTimers())
function channel() {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: vi.fn()
  }) as unknown as ClientChannel
}
function client(callback: (stream: ClientChannel) => void) {
  const stream = channel()
  const exec = vi.fn((_cmd: string, cb: (err: Error | null, ch: ClientChannel) => void) => {
    cb(null, stream)
    callback(stream)
  })
  return { client: { exec } as unknown as Client, stream, exec }
}
it('collects both streams, exit code and timing', async () => {
  const f = client((s) => {
    s.emit('data', Buffer.from('output'))
    s.stderr.emit('data', Buffer.from('failure'))
    s.emit('exit', 2)
    s.emit('close')
  })
  const result = await executeDiagnostic(f.client, 'test', new AbortController().signal)
  expect(result).toMatchObject({
    stdout: 'output',
    stderr: 'failure',
    exitCode: 2,
    outcome: 'completed'
  })
})
it('limits combined output including stderr and closes the channel', async () => {
  const f = client((s) => {
    s.emit('data', Buffer.from('123'))
    s.stderr.emit('data', Buffer.from('456789'))
  })
  const result = await executeDiagnostic(f.client, 'test', new AbortController().signal, 100, 5)
  expect(result).toMatchObject({
    stdout: '123',
    stderr: '45',
    truncated: true,
    outcome: 'truncated'
  })
  expect(f.stream.close).toHaveBeenCalledOnce()
})
it('times out opening the channel and closes a channel arriving late', async () => {
  vi.useFakeTimers()
  let callback!: (err: Error | null, ch: ClientChannel) => void
  const ssh = {
    exec: vi.fn((_cmd: string, cb: typeof callback) => {
      callback = cb
    })
  } as unknown as Client
  const promise = executeDiagnostic(ssh, 'test', new AbortController().signal, 100)
  await vi.advanceTimersByTimeAsync(101)
  expect((await promise).outcome).toBe('timeout')
  const late = channel()
  callback(null, late)
  expect(late.close).toHaveBeenCalledOnce()
})
it('pre-aborted approval never opens a channel', async () => {
  const f = client(() => {})
  const abort = new AbortController()
  abort.abort()
  expect((await executeDiagnostic(f.client, 'test', abort.signal)).outcome).toBe('cancelled')
  expect(f.exec).not.toHaveBeenCalled()
})
it('cancellation returns partial output and ignores subsequent data', async () => {
  const f = client((s) => s.emit('data', Buffer.from('partial')))
  const abort = new AbortController()
  const promise = executeDiagnostic(f.client, 'test', abort.signal)
  abort.abort()
  f.stream.emit('data', 'late')
  expect(await promise).toMatchObject({ stdout: 'partial', outcome: 'cancelled' })
})
it('captures channel errors without unhandled rejection', async () => {
  const f = client((s) => s.emit('error', new Error('connection lost')))
  expect(await executeDiagnostic(f.client, 'test', new AbortController().signal)).toMatchObject({
    outcome: 'error',
    stderr: 'connection lost'
  })
})
