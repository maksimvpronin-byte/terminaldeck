import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'

/**
 * The checks every request passes before a handler sees it. `ipcMain` is an
 * emitter with a table of invoke handlers, which is all of it the guard uses.
 */

const emitter = new EventEmitter()
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => void) => emitter.on(channel, fn),
    once: (channel: string, fn: (...args: unknown[]) => void) => emitter.once(channel, fn),
    removeListener: (channel: string, fn: (...args: unknown[]) => void) =>
      emitter.removeListener(channel, fn),
    off: (channel: string, fn: (...args: unknown[]) => void) => emitter.removeListener(channel, fn)
  }
}))

const { ipcMain } = await import('electron')
const { installSenderCheck, checkTransferPlan } = await import('./guard')
installSenderCheck((url) => url === 'file:///app/renderer/index.html')

function from(url: string, topFrame = true): unknown {
  const mainFrame = { url }
  return { sender: { mainFrame }, senderFrame: topFrame ? mainFrame : { url } }
}

describe('who may ask', () => {
  it('answers the application page and refuses anything else', async () => {
    ipcMain.handle('vault:status', () => 'open')
    const handler = handlers.get('vault:status')!

    expect(await handler(from('file:///app/renderer/index.html'))).toBe('open')
    expect(() => handler(from('https://evil.example/'))).toThrow(/not TerminalDeck/)
    // The right page, but a frame inside it rather than the page itself.
    expect(() => handler(from('file:///app/renderer/index.html', false))).toThrow()
  })

  it('does not pass an untrusted message on, and can still take a listener off', () => {
    const heard: unknown[] = []
    const listener = (_event: unknown, value: unknown): void => void heard.push(value)
    ipcMain.on('ssh:write', listener)

    emitter.emit('ssh:write', from('https://evil.example/'), 'rm -rf /')
    emitter.emit('ssh:write', from('file:///app/renderer/index.html'), 'ls')
    ipcMain.removeListener('ssh:write', listener)
    emitter.emit('ssh:write', from('file:///app/renderer/index.html'), 'after')

    expect(heard).toEqual(['ls'])
  })
})

describe('a transfer plan handed back', () => {
  const plan = {
    direction: 'download',
    items: [{ sourcePath: '/srv/a', destPath: 'C:\\a', sourceSize: 1, sourceMtime: 0 }],
    conflicts: [],
    collisions: [],
    totalBytes: 1
  }

  it('passes a plan of the right shape', () => {
    expect(checkTransferPlan(plan, { 'C:\\a': 'overwrite' }).plan).toBe(plan)
  })

  it('refuses one that is not', () => {
    expect(() => checkTransferPlan({ ...plan, direction: 'sideways' }, {})).toThrow()
    expect(() =>
      checkTransferPlan({ ...plan, items: [{ ...plan.items[0], destPath: 42 }] }, {})
    ).toThrow(/destPath/)
    expect(() => checkTransferPlan(plan, { 'C:\\a': 'always' })).toThrow(/decision/)
  })
})
