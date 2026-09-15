import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'

/**
 * A question put to the window, and every way it can end without an answer.
 * Each of them must take the dialog down as well as settle the promise, or the
 * question stays on screen for a connection that is no longer waiting.
 */

const ipc = new EventEmitter()
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, fn: (...args: unknown[]) => void) => ipc.on(channel, fn),
    removeListener: (channel: string, fn: (...args: unknown[]) => void) =>
      ipc.removeListener(channel, fn)
  }
}))

const { requestAuth } = await import('./authPrompt')

function stubWindow(): { win: BrowserWindow; sent: { channel: string; payload: unknown }[] } {
  const sent: { channel: string; payload: unknown }[] = []
  const events = new EventEmitter()
  const webContents = {
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  }
  const win = Object.assign(events, { isDestroyed: () => false, webContents })
  return { win: win as unknown as BrowserWindow, sent }
}

const QUESTION = {
  host: 'me@host',
  title: 'Password',
  fields: [{ prompt: 'Password', echo: false }]
}

function askedId(sent: { channel: string; payload: unknown }[]): string {
  return (sent.find((s) => s.channel === 'auth:prompt')?.payload as { requestId: string }).requestId
}

beforeEach(() => {
  ipc.removeAllListeners()
  vi.useRealTimers()
})

describe('asking for credentials', () => {
  it('resolves with the answer from the window that was asked', async () => {
    const { win, sent } = stubWindow()
    const asking = requestAuth(win, QUESTION)
    const id = askedId(sent)

    ipc.emit(`auth:promptReply:${id}`, { sender: {} }, ['from somewhere else'])
    ipc.emit(`auth:promptReply:${id}`, { sender: win.webContents }, ['hunter2'])

    await expect(asking).resolves.toEqual(['hunter2'])
  })

  it('takes a malformed answer for a cancel', async () => {
    const { win, sent } = stubWindow()
    const asking = requestAuth(win, QUESTION)
    ipc.emit(`auth:promptReply:${askedId(sent)}`, { sender: win.webContents }, [42])
    await expect(asking).resolves.toBeNull()
  })

  it('withdraws the question when its connection gives up', async () => {
    const { win, sent } = stubWindow()
    const controller = new AbortController()
    const asking = requestAuth(win, QUESTION, { signal: controller.signal })
    const id = askedId(sent)

    controller.abort()

    await expect(asking).resolves.toBeNull()
    expect(sent).toContainEqual({ channel: 'auth:promptCancel', payload: id })
    expect(ipc.listenerCount(`auth:promptReply:${id}`)).toBe(0)
  })

  it('withdraws the question when nobody answers in time', async () => {
    vi.useFakeTimers()
    const { win, sent } = stubWindow()
    const asking = requestAuth(win, QUESTION, { timeoutMs: 1000 })
    const id = askedId(sent)

    vi.advanceTimersByTime(1000)

    await expect(asking).resolves.toBeNull()
    expect(sent).toContainEqual({ channel: 'auth:promptCancel', payload: id })
  })
})
