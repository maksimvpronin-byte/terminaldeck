import { describe, it, expect, vi, afterEach } from 'vitest'
import { PassThrough } from 'stream'

/**
 * What the bridge says to a client that is on its way out.
 *
 * A session leaves the map when its process exits, which is some time after its
 * input has been closed — so between the two there is an entry that looks live
 * and has nowhere to write. Anything speaking on a timer finds it, and the
 * clipboard poll speaks every quarter of a second: it wrote into a closed pipe
 * after a pane was shut and took the whole application down with an uncaught
 * `ERR_STREAM_WRITE_AFTER_END`.
 */
vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp', isPackaged: false },
  clipboard: {
    readText: () => '',
    writeText: () => undefined,
    read: () => '',
    readBuffer: () => Buffer.alloc(0)
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('./clipboardFiles', () => ({
  readFileClipboard: vi.fn(async () => ({ paths: [], version: '1' })),
  writeClipboardFiles: vi.fn(async () => '2'),
  pathsToUris: (paths: string[]) => paths.map((p) => `file://${p}`).join('\r\n')
}))
const { readFileClipboard, writeClipboardFiles } = await import('./clipboardFiles')
const { cleanClipboardDownloads } = await import('./ClipboardDownload')
const { freeRdpBridge } = await import('./FreeRdpBridge')

interface Innards {
  sessions: Map<string, unknown>
  lastClipboardText: string
  lastClipboardFiles: string
  lastClipboardVersion: string
  nextFilesPoll: number
  pollClipboard: () => Promise<void>
  receive: (id: string, session: unknown, type: number, data: Buffer) => void
  write: (id: string, fields: Record<string, unknown>) => void
}

function innards(): Innards {
  return freeRdpBridge as unknown as Innards
}

/** A session whose input can be closed the way a real one's is. */
function stubSession(): {
  session: Record<string, unknown>
  stdin: PassThrough
  written: Buffer[]
} {
  const stdin = new PassThrough()
  const written: Buffer[] = []
  stdin.on('data', (chunk: Buffer) => written.push(chunk))
  const session = {
    child: { stdin },
    window: { isDestroyed: () => false, webContents: { send: () => undefined } },
    host: 'h',
    port: 3389,
    clipboard: true
  }
  return { session, stdin, written }
}

describe('speaking to a desktop client', () => {
  it('says nothing once its input has been closed', async () => {
    const { session, stdin } = stubSession()
    innards().sessions.set('d1', session)
    /*
     * Watched rather than caught. Writing to an ended stream does not throw
     * where the call is made — Node raises it on the stream, and a stream with
     * nobody listening turns that into the uncaught exception that ends the
     * process. So the assertion is that nothing is raised at all, which is also
     * the only assertion that can tell the fix from the bug: a test that merely
     * expected no throw passed either way.
     */
    const raised: Error[] = []
    stdin.on('error', (err: Error) => raised.push(err))

    freeRdpBridge.stop('d1')
    expect(stdin.writableEnded).toBe(true)

    // The poll, a quarter of a second after a pane was shut.
    innards().write('d1', { a: 'clipboard', text: 'anything' })
    // Raised on the next turn, not on this one — which is the other reason the
    // first version of this test passed against the bug it was written for.
    await new Promise((resolve) => setImmediate(resolve))

    expect(raised).toEqual([])
    innards().sessions.delete('d1')
  })

  it('still speaks to one that is running', () => {
    const { session, written } = stubSession()
    innards().sessions.set('d2', session)

    innards().write('d2', { a: 'clipboard', text: 'hello' })

    expect(Buffer.concat(written).toString('utf8')).toContain('hello')
    innards().sessions.delete('d2')
  })
})

afterEach(() => {
  cleanClipboardDownloads()
  vi.clearAllMocks()
  innards().sessions.clear()
})

describe('file clipboard coordination', () => {
  it('offers files that were copied before the desktop connected', async () => {
    const { session, written } = stubSession()
    session.ready = true
    innards().sessions.set('files', session)
    innards().nextFilesPoll = 0
    vi.mocked(readFileClipboard).mockResolvedValueOnce({
      paths: ['/tmp/existing.txt'],
      version: '10'
    })
    await innards().pollClipboard()
    expect(Buffer.concat(written).toString()).toContain('existing.txt')
    expect(Buffer.concat(written).toString()).toContain('clipset')
    expect(session.clipboardSeeded).toBe(true)
  })
  it.each([false, true])(
    'publishes a completed batch only if the local clipboard is unchanged (changed=%s)',
    async (changed) => {
      const { session } = stubSession()
      innards().sessions.set('receive', session)
      innards().lastClipboardText = ''
      innards().lastClipboardFiles = ''
      innards().lastClipboardVersion = '1'
      vi.mocked(readFileClipboard).mockResolvedValue({ paths: [], version: changed ? 'new' : '1' })
      const manifest = Buffer.alloc(596)
      manifest.writeUInt32LE(1)
      manifest.writeUInt32LE(0x44, 4)
      manifest.write('empty.txt', 76, 'utf16le')
      innards().receive('receive', session, 6, manifest)
      await new Promise((resolve) => setImmediate(resolve))
      expect(writeClipboardFiles).toHaveBeenCalledTimes(changed ? 0 : 1)
    }
  )
})
