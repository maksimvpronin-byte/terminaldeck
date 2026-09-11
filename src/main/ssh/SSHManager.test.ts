import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The output path only — how shell output is held, batched and handed to the
 * renderer, and what happens when the renderer cannot keep up. Connecting is
 * not exercised here: it needs a host.
 *
 * A stub connection goes straight into the manager's map, the same way the SFTP
 * tests supply a session, so nothing reaches ssh2.
 */
let userData = ''
vi.mock('electron', () => ({
  app: { getPath: (): string => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: () => undefined, once: () => undefined, removeListener: () => undefined },
  dialog: { showMessageBox: async () => ({ response: 0 }) }
}))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-ssh-'))
const { sshManager, forwarding } = await import('./SSHManager')

interface Sent {
  channel: string
  payload: unknown
}

/** Just enough of a BrowserWindow to record what was sent to the renderer. */
function stubWindow(sent: Sent[]): unknown {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown): void => {
        sent.push({ channel, payload })
      }
    }
  }
}

interface StubStream {
  paused: boolean
  stderrPaused: boolean
}

/** A live connection with a stream that records being paused and resumed. */
function stubConnection(id: string): { conn: Record<string, unknown>; stream: StubStream } {
  const stream: StubStream = { paused: false, stderrPaused: false }
  const conn = {
    id,
    clients: [],
    stream: {
      pause: (): void => {
        stream.paused = true
      },
      resume: (): void => {
        stream.paused = false
      },
      stderr: {
        pause: (): void => {
          stream.stderrPaused = true
        },
        resume: (): void => {
          stream.stderrPaused = false
        }
      }
    },
    followCwd: false,
    outbox: [],
    outboxBytes: 0,
    inFlight: 0,
    paused: false,
    // Listening, unless a test says otherwise — every test written before the
    // handshake existed assumes what it assumed then.
    ready: true,
    pending: []
  }
  return { conn, stream }
}

/** The private surface this file drives. */
interface Innards {
  connections: Map<string, unknown>
  queueOutput: (win: unknown, conn: unknown, data: Buffer) => void
  flushOutput: (win: unknown, conn: unknown) => void
  send: (win: unknown, connectionId: string, channel: string, payload: unknown) => void
  teardown: (connectionId: string) => void
}

function innards(): Innards {
  return sshManager as unknown as Innards
}

function attach(id: string, conn: Record<string, unknown>): void {
  innards().connections.set(id, conn)
}

/** Every payload sent on this connection's data channel, in order. */
function dataSent(sent: Sent[], id: string): Buffer[] {
  return sent.filter((s) => s.channel === `ssh:data:${id}`).map((s) => s.payload as Buffer)
}

beforeEach(() => {
  vi.useFakeTimers()
  innards().connections.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('handing shell output to the renderer', () => {
  it('sends nothing until the interval is up', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c1')
    attach('c1', conn)

    innards().queueOutput(win, conn, Buffer.from('a'))
    expect(dataSent(sent, 'c1')).toHaveLength(0)

    vi.advanceTimersByTime(8)
    expect(dataSent(sent, 'c1')).toHaveLength(1)
  })

  /** A busy shell emits dozens of small chunks a second; they cost one message. */
  it('joins a burst of chunks into one message, in order', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c1')
    attach('c1', conn)

    for (const part of ['one ', 'two ', 'three']) {
      innards().queueOutput(win, conn, Buffer.from(part))
    }
    vi.advanceTimersByTime(8)

    const messages = dataSent(sent, 'c1')
    expect(messages).toHaveLength(1)
    expect(messages[0].toString('utf8')).toBe('one two three')
  })

  it('sends bytes, not base64', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c1')
    attach('c1', conn)

    innards().queueOutput(win, conn, Buffer.from([0x1b, 0x5b, 0x41, 0xff]))
    vi.advanceTimersByTime(8)

    const [payload] = dataSent(sent, 'c1')
    expect(Buffer.isBuffer(payload)).toBe(true)
    expect([...payload]).toEqual([0x1b, 0x5b, 0x41, 0xff])
  })

  it('does not wait once enough has piled up', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c1')
    attach('c1', conn)

    innards().queueOutput(win, conn, Buffer.alloc(64 * 1024, 0x61))

    // No timer has fired, and it is already on its way.
    expect(dataSent(sent, 'c1')).toHaveLength(1)
  })

  it('keeps quiet when there is nothing held', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c1')
    attach('c1', conn)

    innards().flushOutput(win, conn)

    expect(dataSent(sent, 'c1')).toHaveLength(0)
  })
})

/**
 * Without this, output the terminal cannot keep up with simply accumulates.
 * The renderer acknowledges each chunk once xterm has parsed it, and that is
 * the only thing that starts a paused connection again.
 */
describe('when the renderer falls behind', () => {
  const MEGABYTE = 1024 * 1024

  function flood(id = 'c1'): {
    stream: StubStream
    sent: Sent[]
    again: () => void
  } {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn, stream } = stubConnection(id)
    attach(id, conn)
    const again = (): void => innards().queueOutput(win, conn, Buffer.alloc(MEGABYTE, 0x61))
    again()
    return { stream, sent, again }
  }

  it('asks the host to stop once too much is outstanding', () => {
    const { stream } = flood()

    expect(stream.paused).toBe(true)
    // stderr is a readable of its own; a build pouring warnings out of it
    // floods just as well.
    expect(stream.stderrPaused).toBe(true)
  })

  it('stays paused while the renderer is still behind', () => {
    const { stream } = flood()

    sshManager.acknowledge('c1', 256 * 1024)

    expect(stream.paused).toBe(true)
  })

  it('starts again once the renderer has caught up', () => {
    const { stream } = flood()

    sshManager.acknowledge('c1', MEGABYTE)

    expect(stream.paused).toBe(false)
    expect(stream.stderrPaused).toBe(false)
  })

  it('is not moved by an acknowledgement for a connection that has gone', () => {
    const { stream } = flood()

    expect(() => sshManager.acknowledge('not a connection', MEGABYTE)).not.toThrow()
    expect(stream.paused).toBe(true)
  })

  it('cannot be talked into a negative backlog', () => {
    const { stream, again } = flood()

    // More acknowledged than was ever sent — a renderer that double-reports, or
    // a chunk counted twice on the way out.
    sshManager.acknowledge('c1', MEGABYTE * 10)
    expect(stream.paused).toBe(false)

    // A backlog that had gone to minus nine megabytes would swallow the next
    // flood whole and never pause again.
    again()

    expect(stream.paused).toBe(true)
  })
})

describe('agent forwarding', () => {
  const auth = (agentForward: boolean): Parameters<typeof forwarding>[0] =>
    ({ agentForward }) as Parameters<typeof forwarding>[0]

  const withSock = <T>(sock: string | undefined, run: () => T): T => {
    const had = process.env.SSH_AUTH_SOCK
    if (sock === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = sock
    try {
      return run()
    } finally {
      if (had === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = had
    }
  }

  it('says nothing when nobody asked for it', () => {
    expect(withSock('/tmp/agent.sock', () => forwarding(auth(false)))).toEqual({})
  })

  /**
   * The point of the whole function. How you prove who you are and whether your
   * agent travels with you are two questions, and this used to answer them as
   * one: the flag was attached only to the agent branch, so a host signing in
   * with a password showed the checkbox, remembered it, and forwarded nothing.
   */
  it('forwards for a host that signs in some other way', () => {
    expect(withSock('/tmp/agent.sock', () => forwarding(auth(true)))).toEqual({
      agent: '/tmp/agent.sock',
      agentForward: true
    })
  })

  it('asks for nothing when there is no agent to forward', () => {
    // ssh2 needs the socket named before it will forward it, so without one
    // there is nothing to say — and saying `agentForward` alone is an error.
    if (process.platform === 'win32') return
    expect(withSock(undefined, () => forwarding(auth(true)))).toEqual({})
  })
})

/**
 * Nothing may be said to a window that is not listening yet.
 *
 * The renderer cannot subscribe to a connection's channels until it knows the
 * id, and it only learns the id when `connect` resolves. Everything sent in
 * between went to a channel nobody was on, and Electron drops those silently.
 * The shell's greeting went that way now and then; the message about a tunnel
 * that refused to come up went that way every time, because it is sent while
 * `connect` is still working.
 */
describe('what is said before the window is listening', () => {
  it('holds it, and says it in order once the window speaks', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c-hold')
    conn.ready = false
    attach('c-hold', conn)

    innards().send(win, 'c-hold', 'ssh:status', 'connected')
    innards().send(win, 'c-hold', 'ssh:error', 'tunnel 8080 failed: address in use')
    expect(sent).toEqual([])

    sshManager.markReady(win as never, 'c-hold')

    expect(sent).toEqual([
      { channel: 'ssh:status:c-hold', payload: 'connected' },
      { channel: 'ssh:error:c-hold', payload: 'tunnel 8080 failed: address in use' }
    ])
  })

  /**
   * A session can fail before the window ever subscribes, and what it held is
   * the reason it failed — the most useful thing it ever had to say.
   */
  it('still delivers what a connection held when it died before being heard', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c-dead')
    conn.ready = false
    attach('c-dead', conn)

    innards().send(win, 'c-dead', 'ssh:error', 'tunnel 8080 failed: address in use')
    innards().teardown('c-dead')
    expect(sent).toEqual([])

    sshManager.markReady(win as never, 'c-dead')

    expect(sent).toEqual([
      { channel: 'ssh:error:c-dead', payload: 'tunnel 8080 failed: address in use' }
    ])
  })

  it('says nothing twice when the window speaks again', () => {
    const sent: Sent[] = []
    const win = stubWindow(sent)
    const { conn } = stubConnection('c-twice')
    conn.ready = false
    attach('c-twice', conn)

    innards().send(win, 'c-twice', 'ssh:status', 'connected')
    sshManager.markReady(win as never, 'c-twice')
    sshManager.markReady(win as never, 'c-twice')

    expect(sent).toHaveLength(1)
  })
})

/**
 * A session ends two ways and only one of them went through the disconnect
 * handler. A shell that ended on its own — `exit`, or a dropped link — left
 * the SFTP channels open, the remote edits watched, the monitor polling, and
 * the forwarded ports listening: bound to nothing and unavailable to the next
 * connection or to anything else on the machine.
 */
describe('when a connection ends on its own', () => {
  it('tells whoever is holding things for it, before anything is closed', () => {
    const told: string[] = []
    sshManager.onClosed((id) => told.push(id))
    const { conn } = stubConnection('c-exit')
    attach('c-exit', conn)

    innards().teardown('c-exit')

    expect(told).toEqual(['c-exit'])
    expect(innards().connections.has('c-exit')).toBe(false)
  })
})
