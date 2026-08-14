import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'

/**
 * Drives ShadowHost.exe, which shows a shadow session inside a pane.
 *
 * The window is not drawn by this app: `mstsc` draws it, ShadowHost adopts it,
 * and this side only says where to put it. So the pane reports its rectangle
 * whenever it moves and the host follows — there is nothing here that Chromium
 * composites, and nothing it knows about either.
 *
 * Windows only, for the same reason shadowing is: no other platform has a
 * client that speaks it.
 */

export interface ShadowRequest {
  host: string
  sessionId: number
  control: boolean
  noPrompt: boolean
  /** The saved connection this came from, so the host's credentials can be
   *  looked up. Not the Windows session number above. */
  profileId?: string
}

/** What the viewer needs to be the host's user rather than this machine's. */
export interface ShadowCredentials {
  username: string
  password: string
}

/** A rectangle in the renderer's CSS pixels, relative to the page. */
export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}

interface Session {
  child: ChildProcess
  window: BrowserWindow
}

/** A line in the terminal running the app, on the same switch the rest of RDP uses. */
const tracing =
  process.env.NODE_ENV === 'development' || process.env.TERMINALDECK_RDP_TRACE === '1'

function trace(message: string): void {
  if (!tracing) return
  // eslint-disable-next-line no-console
  console.log(`[shadow] ${message}`)
}

function hostExecutable(): string {
  // Packaged, the executable travels in resources beside app.asar; in
  // development it sits where the compiler put it.
  return app.isPackaged
    ? join(process.resourcesPath, 'shadowhost', 'ShadowHost.exe')
    : join(app.getAppPath(), 'resources', 'shadowhost', 'ShadowHost.exe')
}

class ShadowHostBridge {
  private sessions = new Map<string, Session>()
  private nextId = 1

  start(window: BrowserWindow, request: ShadowRequest, credentials?: ShadowCredentials): string {
    if (process.platform !== 'win32') throw new Error('Shadowing is only possible on Windows')

    // Which identity the viewer gets decides whether the host will talk to it at
    // all, and the pane can only ever report "access denied" either way.
    trace(
      credentials
        ? `starting the viewer as ${credentials.username}`
        : `starting the viewer as this machine's signed-in user: ` +
            (request.profileId
              ? 'the saved connection has no username and password'
              : 'no saved connection was named')
    )

    const id = `shadow${this.nextId++}`
    const child = spawn(hostExecutable(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.sessions.set(id, { child, window })

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      // One line, one message: the host flushes each and never splits one.
      let cut: number
      while ((cut = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, cut).trim()
        buffered = buffered.slice(cut + 1)
        if (line) this.report(id, window, line)
      }
    })

    // The host dying is the session ending, however it happened.
    child.on('exit', () => {
      this.sessions.delete(id)
      this.say(window, id, { event: 'ended', detail: 'the viewer closed' })
    })
    child.on('error', (err: Error) => {
      this.sessions.delete(id)
      this.say(window, id, { event: 'error', detail: err.message })
    })

    this.send(id, {
      action: 'start',
      host: request.host,
      sessionId: request.sessionId,
      control: request.control,
      noPrompt: request.noPrompt,
      // So the host's window can be owned by this one: owned floats above and
      // minimises with it, without tying the two input queues together.
      owner: readHandle(window),
      // Down the pipe, never on a command line or in the environment: an
      // argument is readable by anything that can list processes.
      user: credentials?.username,
      password: credentials?.password
    })
    return id
  }

  /**
   * Puts the host's window over the pane.
   *
   * The renderer measures in CSS pixels relative to the page; the window wants
   * screen pixels. Both corrections matter — the content area does not start at
   * the screen origin, and a scaled display counts pixels differently.
   */
  place(id: string, rect: PaneRect): void {
    const session = this.sessions.get(id)
    if (!session) return
    const content = session.window.getContentBounds()
    const scale = session.window.webContents.getZoomFactor()

    this.send(id, {
      action: 'bounds',
      x: Math.round(content.x + rect.x * scale),
      y: Math.round(content.y + rect.y * scale),
      w: Math.max(1, Math.round(rect.width * scale)),
      h: Math.max(1, Math.round(rect.height * scale))
    })
  }

  setVisible(id: string, visible: boolean): void {
    this.send(id, { action: visible ? 'show' : 'hide' })
  }

  stop(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.send(id, { action: 'stop' })
    // Closing stdin is the backstop: the host exits on it even if the message
    // never arrives, so a wedged viewer cannot outlive its pane.
    session.child.stdin?.end()
  }

  /** Nothing should outlive the window that asked for it. */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  private send(id: string, message: Record<string, unknown>): void {
    const session = this.sessions.get(id)
    session?.child.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private report(id: string, window: BrowserWindow, line: string): void {
    try {
      this.say(window, id, JSON.parse(line) as Record<string, unknown>)
    } catch {
      this.say(window, id, { event: 'error', detail: line })
    }
  }

  private say(window: BrowserWindow, id: string, payload: Record<string, unknown>): void {
    if (!window.isDestroyed()) window.webContents.send(`${IPC.shadowEvent}:${id}`, payload)
  }
}

/** The window handle, as the number ShadowHost expects to be given. */
function readHandle(window: BrowserWindow): number {
  const buffer = window.getNativeWindowHandle()
  return buffer.length >= 4 ? buffer.readInt32LE(0) : 0
}

export const shadowHostBridge = new ShadowHostBridge()
