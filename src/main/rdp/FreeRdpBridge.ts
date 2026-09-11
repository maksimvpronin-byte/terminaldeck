import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { X509Certificate } from 'crypto'
import { app, clipboard, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { askAboutCertificate } from './certificateVerifier'
import { requireUnlocked } from '../vault/locked'
import { createRecordReader, encodeCommand, readCursor, readFrame, RECORD } from './recordStream'
import { complaintIn, failureText } from './clientLog'

/**
 * Drives td-rdp, which is what draws a desktop pane.
 *
 * The client is FreeRDP, in a process of its own, and this is the whole of the
 * seam: instructions down its stdin, pixels back up its stdout. The reasons for
 * a separate process are worth stating: a decoder fault ends a pane rather than
 * the window, nothing is bound to Electron's ABI, and authentication happens
 * out there, so a stored password goes vault → main → pipe and never enters the
 * window at all. The client it replaced authenticated in the renderer, which
 * forced the one exception this app made to that rule.
 *
 * See resources/freerdp/shim/ for the other end, and PLAN-freerdp.md for why
 * any of this exists.
 */

/** Everything needed to open one desktop, resolved before this is called. */
export interface DesktopRequest {
  host: string
  port?: number
  /** In the far end's own pixels; see shared/desktopSize.ts. */
  width: number
  height: number
  /** 100–500, or nothing to leave the field at zero and be ignored. */
  scale?: number
  sound?: boolean
  /** Whether this desktop shares its clipboard with this machine. */
  clipboard?: boolean
  fontSmoothing?: boolean
  composition?: boolean
  noWallpaper?: boolean
}

/** Who to be. Never sent to the renderer, and never in an argument list. */
export interface DesktopCredentials {
  username: string
  password: string
  domain?: string
}

/** The RD Gateway, when there is one. */
export interface DesktopGateway {
  host: string
  port?: number
  username?: string
  password?: string
  domain?: string
  /** Reach a host on a private address directly, skipping the gateway. */
  bypassLocal?: boolean
}

interface Session {
  child: ChildProcess
  window: BrowserWindow
  host: string
  port: number
  /** Whether this desktop shares a clipboard. Off unless the host asked. */
  clipboard: boolean
  /**
   * Told to go, and not yet gone.
   *
   * A session leaves the map when its process exits, which is some time after
   * its input is closed — so between the two there is a session that looks
   * live and has nowhere to write. Anything that speaks on a timer will find
   * it: the clipboard poll did, wrote into a closed pipe a quarter of a second
   * after a pane was shut, and took the whole application down with an
   * uncaught `ERR_STREAM_WRITE_AFTER_END`.
   */
  stopping?: boolean
  /** The client's last complaint, which is usually the reason it stopped. */
  complaint?: string
}

/**
 * How often the local clipboard is read while a sharing desktop is open.
 *
 * There is no event for it — neither Electron nor any platform underneath
 * offers one — so it is a poll or it is nothing. Four times a second is under
 * the threshold where a paste feels like it waited, and reading a string
 * somebody may not have changed costs nothing worth measuring.
 */
const CLIPBOARD_POLL_MS = 250

/**
 * A line in the terminal running the app, on the same switch the rest of the
 * desktop side uses. Off by default: a session logs several lines per frame at
 * FreeRDP's DEBUG, and that is a diagnostic, not a default.
 */
const tracing = process.env.NODE_ENV === 'development' || process.env.TERMINALDECK_RDP_TRACE === '1'

function trace(message: string): void {
  if (!tracing) return
  // eslint-disable-next-line no-console
  console.log(`[rdp client] ${message}`)
}

function executable(): string {
  const name = process.platform === 'win32' ? 'td-rdp.exe' : 'td-rdp'
  if (app.isPackaged) return join(process.resourcesPath, 'freerdp', 'bin', name)
  // In development it sits where the build script put it, in a directory named
  // for the platform and architecture it was built for — the same two words
  // electron-builder uses, so the path is spelled once.
  const platform =
    process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return join(
    app.getAppPath(),
    'resources',
    'freerdp',
    'build',
    `${platform}-${process.arch}`,
    'bin',
    name
  )
}

class FreeRdpBridge {
  private sessions = new Map<string, Session>()
  private nextId = 1

  /**
   * Starting a desktop is starting a session, and a locked vault refuses those
   * for the same reason it refuses an SSH connection: a host whose password is
   * typed at the far end needs nothing from the vault, so nothing else would
   * have stopped it. See `vault/locked.ts`.
   */
  start(
    window: BrowserWindow,
    request: DesktopRequest,
    credentials: DesktopCredentials,
    gateway?: DesktopGateway
  ): string {
    requireUnlocked()
    const id = `desktop${this.nextId++}`
    const port = request.port ?? 3389

    const child = spawn(executable(), [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // FreeRDP reads its own level from the environment. Off unless asked
        // for by hand, for the reason the last client taught: a desktop logs
        // several lines per frame, and that is a diagnostic, not a default.
        WLOG_LEVEL: process.env.TERMINALDECK_RDP_TRACE ? 'DEBUG' : 'WARN'
      }
    })

    const session: Session = {
      child,
      window,
      host: request.host,
      port,
      clipboard: Boolean(request.clipboard)
    }
    this.sessions.set(id, session)
    this.watchClipboard()

    const reader = createRecordReader(
      (type, payload) => this.receive(id, session, type, payload),
      (why) =>
        this.say(session, id, { e: 'failed', detail: `the client's output made no sense: ${why}` })
    )
    child.stdout?.on('data', (chunk: Buffer) => reader.push(chunk))

    /**
     * The client's own log, which is where the reason for a failure lives.
     *
     * Everything FreeRDP writes arrives here — the shim points descriptor 1 at
     * 2 so that a library writing to stdout cannot land in the middle of a
     * frame — and the line naming a refusal is written at ERROR, which the
     * WARN level above already lets through. Draining this into nothing was
     * the reason "the connection failed at negotiating security settings" was
     * all anyone ever got: FreeRDP's summary names the step, and the line one
     * moment earlier names which of the several things that step covers went
     * wrong.
     *
     * Only the complaint is kept: a buffer of the rest would be read by
     * nothing, and the lines themselves are already in the terminal whenever
     * tracing is on.
     */
    let pending = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split('\n')
      // Whatever follows the last newline is half a line, and waits here for
      // the rest of itself rather than being read as a short one.
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trimEnd()
        if (!text.trim()) continue
        trace(`${id} ${text}`)
        const complaint = complaintIn(text)
        if (complaint) session.complaint = complaint
      }
    })

    child.on('exit', (code) => {
      this.sessions.delete(id)
      this.watchClipboard()
      this.say(session, id, {
        e: 'closed',
        detail:
          code === 0 ? 'the session ended' : `the desktop client stopped (${code ?? 'killed'})`
      })
    })
    child.on('error', (err: Error) => {
      this.sessions.delete(id)
      this.watchClipboard()
      this.say(session, id, {
        e: 'failed',
        // The common case by far, and worth naming: a checkout without the
        // client built says nothing useful otherwise.
        detail: /ENOENT/.test(err.message)
          ? 'The desktop client is missing. Build it with: npm run build:freerdp:mac'
          : err.message
      })
    })

    this.write(id, {
      a: 'start',
      host: request.host,
      port,
      user: credentials.username,
      domain: credentials.domain,
      password: credentials.password,
      width: request.width,
      height: request.height,
      scale: request.scale,
      sound: request.sound,
      clipboard: request.clipboard,
      fontSmoothing: request.fontSmoothing,
      composition: request.composition,
      noWallpaper: request.noWallpaper,
      gatewayHost: gateway?.host,
      gatewayPort: gateway?.port,
      // Stated rather than inferred: on most deployments the gateway takes the
      // same login and on exactly the others, guessing locks an account out.
      gatewaySameCredentials: gateway ? !gateway.username : undefined,
      gatewayUser: gateway?.username,
      gatewayDomain: gateway?.domain,
      gatewayPassword: gateway?.password,
      gatewayBypassLocal: gateway?.bypassLocal
    })

    return id
  }

  /** Anything the renderer wants said: input, a new size, an acknowledgement. */
  send(id: string, fields: Record<string, string | number | boolean | undefined>): void {
    this.write(id, fields)
  }

  stop(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.stopping) return
    this.write(id, { a: 'stop' })
    // Marked before the pipe is closed, not after: everything that writes goes
    // through one place and that place refuses a session in this state.
    session.stopping = true
    // Closing the pipe is the backstop: the client exits on end-of-input
    // whether or not the message arrived.
    session.child.stdin?.end()
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  /**
   * What was last on the clipboard, whichever side put it there.
   *
   * One value for every session rather than one each: the local clipboard is
   * one thing, and two desktops sharing it should agree about what is on it.
   */
  private lastClipboardText = ''
  /** The same, for the files beside it: copying a file changes neither text. */
  private lastClipboardFiles = ''
  private clipboardTimer: NodeJS.Timeout | undefined

  /**
   * The files on the clipboard, as a `text/uri-list`, or an empty string.
   *
   * macOS puts several of them on the pasteboard one item at a time, which
   * Electron's clipboard cannot walk — it reads the first item and stops. The
   * legacy `NSFilenamesPboardType` is one value holding all of them, written by
   * Finder to this day for exactly the applications that cannot walk items, and
   * is read here first for that reason. A single file is the fallback, and the
   * common case.
   */
  private clipboardFiles(): string {
    const paths: string[] = []
    try {
      const plist = clipboard.readBuffer('NSFilenamesPboardType').toString('utf8')
      for (const match of plist.matchAll(/<string>([^<]*)<\/string>/g)) paths.push(match[1])
    } catch {
      // Not on the pasteboard, or not this platform. The single file below.
    }
    if (paths.length === 0) {
      const one = clipboard.read('public.file-url')
      if (one) paths.push(decodeURIComponent(one.replace(/^file:\/\//, '')))
    }
    if (paths.length === 0) return ''
    // CRLF-separated `file://` URIs, which is what the client's file helper
    // parses — see `cliprdr_local_stream_update`.
    return paths
      .map((path) => `file://${path.split('/').map(encodeURIComponent).join('/')}`)
      .join('\r\n')
  }

  /** Runs only while at least one open desktop shares a clipboard. */
  private watchClipboard(): void {
    const wanted = [...this.sessions.values()].some((s) => s.clipboard)
    if (!wanted) {
      if (this.clipboardTimer) clearInterval(this.clipboardTimer)
      this.clipboardTimer = undefined
      return
    }
    if (this.clipboardTimer) return

    this.lastClipboardText = clipboard.readText()
    this.lastClipboardFiles = this.clipboardFiles()
    this.clipboardTimer = setInterval(() => {
      const text = clipboard.readText()
      const files = this.clipboardFiles()
      if (text === this.lastClipboardText && files === this.lastClipboardFiles) return
      const textChanged = text !== this.lastClipboardText
      const filesChanged = files !== this.lastClipboardFiles
      this.lastClipboardText = text
      this.lastClipboardFiles = files
      for (const [id, session] of this.sessions) {
        if (!session.clipboard) continue
        if (textChanged) this.write(id, { a: 'clipboard', text })
        if (filesChanged) this.write(id, { a: 'clipfiles', uris: files })
      }
    }, CLIPBOARD_POLL_MS)
    // Nothing here should hold the process open by itself.
    this.clipboardTimer.unref?.()
  }

  private write(id: string, fields: Record<string, string | number | boolean | undefined>): void {
    const session = this.sessions.get(id)
    const stdin = session?.child.stdin
    if (!session || session.stopping || !stdin || !stdin.writable) return
    try {
      stdin.write(encodeCommand(fields))
    } catch {
      /*
       * A pipe can close between the check above and the line under it — the
       * client exits on its own account, and nothing here is told first. Saying
       * something to a session that has gone is not an error worth raising: it
       * is the ordinary end of every session, and raising it here killed the
       * application rather than the write.
       */
    }
  }

  private receive(id: string, session: Session, type: number, payload: Buffer): void {
    if (type === RECORD.frame) {
      const frame = readFrame(payload)
      /**
       * A frame that cannot be delivered is acknowledged anyway.
       *
       * The client holds at most one frame in flight and waits for the
       * acknowledgement before sending the next, which is what keeps a slow
       * renderer from growing a queue. The other side of that bargain is that
       * every frame must be answered: dropping one silently — because it did
       * not describe itself correctly, or because the window has gone — stops
       * the picture for good rather than for a moment. The renderer already
       * acknowledges a frame its canvas refused; this is the same rule, in the
       * one place it was missing.
       */
      if (!frame || session.window.isDestroyed()) {
        this.write(id, { a: 'ack' })
        return
      }
      session.window.webContents.send(`${IPC.desktopFrame}:${id}`, {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        pixels: frame.pixels
      })
      return
    }

    if (type === RECORD.cursor) {
      const cursor = readCursor(payload)
      if (cursor && !session.window.isDestroyed()) {
        session.window.webContents.send(`${IPC.desktopCursor}:${id}`, cursor)
      }
      return
    }

    if (type === RECORD.cursorState) {
      const kind = payload.length > 0 && payload[0] === 1 ? 'default' : 'hidden'
      if (!session.window.isDestroyed()) {
        session.window.webContents.send(`${IPC.desktopCursor}:${id}`, { kind })
      }
      return
    }

    if (type === RECORD.clipboard) {
      if (!session.clipboard) return
      const text = payload.toString('utf8')
      /*
       * Remembered before it is written, and that order is the whole trick:
       * writing it fires nothing, but the poll below would read it back a
       * quarter of a second later, see something new, and send it to the
       * machine it just came from — which answers with a format list, and the
       * two sides pass one string back and forth for as long as the session
       * lasts.
       */
      this.lastClipboardText = text
      clipboard.writeText(text)
      return
    }

    if (type !== RECORD.event) return

    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }

    if (event.e === 'certificate') {
      void this.decideCertificate(id, session, event)
      return
    }
    if (event.e === 'failed') {
      const detail = failureText(
        String(event.detail ?? ''),
        session.complaint,
        Number(event.code ?? 0)
      )
      this.say(session, id, { ...event, detail })
      return
    }
    this.say(session, id, event)
  }

  /**
   * Whether this desktop's certificate is acceptable.
   *
   * Answered here rather than in the client, and with the store the rest of
   * the application already uses: the RD Gateway code asks the same question
   * through the same door, so a host trusted once is trusted by both. The
   * client hands over the certificate itself for exactly this reason — its own
   * fingerprint is in a different format, and a second store would eventually
   * disagree with the first about the same host.
   */
  private async decideCertificate(
    id: string,
    session: Session,
    event: Record<string, unknown>
  ): Promise<void> {
    let trusted = false
    const flags = Number(event.flags ?? 0)
    try {
      const certificate = new X509Certificate(String(event.pem ?? ''))
      trusted = await askAboutCertificate({
        host: String(event.host ?? session.host),
        port: Number(event.port ?? session.port),
        der: certificate.raw,
        // The client only asks when its own check failed; one that passed is
        // never put to anybody.
        authorized: false,
        problem: describeCertificateFlags(flags),
        // The same question is asked about the gateway on the way through, and
        // the dialog names which of the two it is talking about.
        what: flags & CERT_GATEWAY ? 'the gateway' : 'the desktop host'
      })
    } catch {
      // An unparseable certificate is not one to accept.
      trusted = false
    }
    this.write(id, { a: 'cert', trust: trusted })
  }

  private say(session: Session, id: string, payload: Record<string, unknown>): void {
    if (!session.window.isDestroyed()) {
      session.window.webContents.send(`${IPC.desktopEvent}:${id}`, payload)
    }
  }
}

/**
 * What the client could not settle on its own, in words.
 *
 * The dialog says this out loud, because "not trusted" covers a name that does
 * not match and a certificate that changed since last time, and those are two
 * different conversations with whoever is reading. The values are FreeRDP's
 * own VERIFY_CERT_FLAG_*.
 */
const CERT_MISMATCH = 0x80
const CERT_CHANGED = 0x40
const CERT_GATEWAY = 0x20
const CERT_REDIRECT = 0x10

function describeCertificateFlags(flags: number): string | undefined {
  const reasons: string[] = []
  if (flags & CERT_MISMATCH) reasons.push('the name on it does not match the host')
  if (flags & CERT_CHANGED) reasons.push('it is not the certificate this host showed last time')
  if (flags & CERT_REDIRECT) reasons.push('it belongs to a host this connection was redirected to')
  return reasons.length > 0 ? reasons.join(', ') : undefined
}

export const freeRdpBridge = new FreeRdpBridge()
