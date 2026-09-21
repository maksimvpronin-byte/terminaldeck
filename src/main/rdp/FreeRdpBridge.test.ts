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
    readText: vi.fn(() => ''),
    writeText: vi.fn(),
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
/** Open unless a test says otherwise; the lock is what some of these are about. */
const vaultState = { unlocked: true }
vi.mock('../vault/locked', () => ({
  isUnlocked: () => vaultState.unlocked,
  requireUnlocked: () => undefined
}))
const { readFileClipboard, writeClipboardFiles } = await import('./clipboardFiles')
const { cleanClipboardDownloads } = await import('./ClipboardDownload')
const { clipboard } = await import('electron')
const { freeRdpBridge } = await import('./FreeRdpBridge')
const { RECORD } = await import('./recordStream')

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
    window: {
      isDestroyed: () => false,
      isFocused: () => true,
      webContents: { send: () => undefined }
    },
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
  vaultState.unlocked = true
  vi.mocked(clipboard.readText).mockReturnValue('')
  cleanClipboardDownloads()
  vi.clearAllMocks()
  innards().sessions.clear()
})

describe('file clipboard coordination', () => {
  it('forwards a native upload failure to the session UI without ending the session', () => {
    const { session } = stubSession()
    const send = vi.fn()
    session.window = { isDestroyed: () => false, isFocused: () => true, webContents: { send } }
    session.ready = true
    const event = {
      e: 'clipboard-transfer',
      state: 'error',
      detail: 'Cannot read local file contents (error 32)'
    }
    innards().receive('upload', session, 1, Buffer.from(JSON.stringify(event)))
    expect(send).toHaveBeenCalledWith(expect.any(String), event)
    expect(session.ready).toBe(true)
    expect(session.stopping).toBeUndefined()
  })
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
    expect(session.clipboardSent).toBeDefined()
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

/**
 * What crosses to a desktop while nobody is at TerminalDeck.
 *
 * The poll read the local clipboard and sent every change to every open desktop
 * whatever the state of the application: locked, in the background, or both.
 * A password copied out of a password manager after locking went straight to
 * each desktop left open behind the lock.
 */
describe('clipboard while nobody is here', () => {
  function liveSession(): ReturnType<typeof stubSession> & { focused: { value: boolean } } {
    const stub = stubSession()
    const focused = { value: true }
    stub.session.ready = true
    stub.session.window = {
      isDestroyed: () => false,
      isFocused: () => focused.value,
      webContents: { send: () => undefined }
    }
    return { ...stub, focused }
  }

  function reset(text: string): void {
    innards().lastClipboardText = text
    innards().lastClipboardFiles = ''
    innards().lastClipboardVersion = ''
    innards().nextFilesPoll = Date.now() + 60_000
  }

  it('sends nothing while the vault is locked', async () => {
    const { session, written } = liveSession()
    innards().sessions.set('locked', session)
    reset('before')
    vaultState.unlocked = false

    vi.mocked(clipboard.readText).mockReturnValue('copied after locking')
    await innards().pollClipboard()

    expect(Buffer.concat(written).toString()).not.toContain('copied after locking')
  })

  it('holds a change for a desktop whose window is in the background, and sends it once back', async () => {
    const { session, written, focused } = liveSession()
    innards().sessions.set('background', session)
    reset('before')
    session.clipboardSent = 0
    focused.value = false

    vi.mocked(clipboard.readText).mockReturnValue('copied elsewhere')
    await innards().pollClipboard()
    expect(Buffer.concat(written).toString()).not.toContain('copied elsewhere')

    focused.value = true
    await innards().pollClipboard()
    await innards().pollClipboard()
    const sent = Buffer.concat(written).toString()
    expect(sent).toContain('copied elsewhere')
    expect(sent.split('copied elsewhere')).toHaveLength(2)
  })

  it('offers every desktop an empty clipboard once when the vault locks', async () => {
    const { session, written } = liveSession()
    innards().sessions.set('withdrawn', session)
    session.clipboardSent = 3
    vaultState.unlocked = false

    await innards().pollClipboard()
    await innards().pollClipboard()

    const sent = Buffer.concat(written).toString()
    expect(sent.split('clipset')).toHaveLength(2)
    expect(session.clipboardSent).toBeUndefined()
  })

  /**
   * The window having the focus said nothing about which of its desktops was
   * in use: one in a background tab went on being handed everything copied
   * while somebody worked in the tab next to it.
   */
  it('holds a change for a desktop in a hidden tab, and sends it once shown', async () => {
    const { session, written } = liveSession()
    innards().sessions.set('hidden-tab', session)
    reset('before')
    session.clipboardSent = 0

    freeRdpBridge.send('hidden-tab', { a: 'visible', value: false })
    vi.mocked(clipboard.readText).mockReturnValue('meant for the other tab')
    await innards().pollClipboard()
    expect(Buffer.concat(written).toString()).not.toContain('meant for the other tab')

    freeRdpBridge.send('hidden-tab', { a: 'visible', value: true })
    await innards().pollClipboard()
    expect(Buffer.concat(written).toString()).toContain('meant for the other tab')
  })

  it('does not take what a desktop in a hidden tab copied', () => {
    const { session } = liveSession()
    innards().sessions.set('hidden-copy', session)
    freeRdpBridge.send('hidden-copy', { a: 'visible', value: false })

    innards().receive('hidden-copy', session, RECORD.clipboard, Buffer.from('from behind'))
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  /**
   * A download being published made the poll return early, so a lock in that
   * time was not acted on — and the publishing, whose only check of the vault
   * came before its wait, went on to put the files on this machine anyway.
   */
  it('withdraws the clipboard and publishes nothing when the vault locks mid-publish', async () => {
    const { session, written } = liveSession()
    innards().sessions.set('publishing', session)
    reset('')
    let finishRead: (value: { paths: string[]; version: string }) => void = () => undefined
    vi.mocked(readFileClipboard).mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = resolve))
    )
    const bridge = freeRdpBridge as unknown as {
      beginClipboardDownload: (id: string, session: unknown, manifest: Buffer) => void
      clipboardPublishing: boolean
    }
    bridge.beginClipboardDownload('publishing', session, Buffer.alloc(4))
    const download = session.download as unknown as { complete: (paths: string[]) => void }
    download.complete(['/staged/file.txt'])
    expect(bridge.clipboardPublishing).toBe(true)

    vaultState.unlocked = false
    await innards().pollClipboard()
    expect(Buffer.concat(written).toString()).toContain('clipset')

    finishRead({ paths: [], version: '1' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(writeClipboardFiles).not.toHaveBeenCalled()
  })

  /**
   * A desktop in a background pane, or behind another application, went on
   * replacing this machine's clipboard with whatever it copied.
   */
  it('does not take what a desktop copied while its window is in the background', () => {
    const { session, focused } = liveSession()
    innards().sessions.set('remote-copy', session)
    focused.value = false

    innards().receive('remote-copy', session, RECORD.clipboard, Buffer.from('from the far end'))
    expect(clipboard.writeText).not.toHaveBeenCalled()

    focused.value = true
    innards().receive('remote-copy', session, RECORD.clipboard, Buffer.from('from the far end'))
    expect(clipboard.writeText).toHaveBeenCalledWith('from the far end')
  })
})
