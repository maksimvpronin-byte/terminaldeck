import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { X509Certificate } from 'crypto'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { askAboutCertificate } from './certificateVerifier'
import {
  createRecordReader,
  encodeCommand,
  readCursor,
  readFrame,
  RECORD
} from './recordStream'

/**
 * Drives td-rdp, which is what draws a desktop pane.
 *
 * The client is FreeRDP, in a process of its own, and this is the whole of the
 * seam: instructions down its stdin, pixels back up its stdout. The reasons for
 * a separate process are the ones ShadowHost.exe was given — a decoder fault
 * ends a pane rather than the window, and nothing is bound to Electron's ABI —
 * and one more that only applies here: authentication happens in that process,
 * so a stored password now goes vault → main → pipe and never enters the
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
  /** The last lines the client wrote about itself, for when it fails. */
  log: string[]
  host: string
  port: number
}

/** How much of the client's own log to keep. */
const LOG_LINES = 400

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

  start(
    window: BrowserWindow,
    request: DesktopRequest,
    credentials: DesktopCredentials,
    gateway?: DesktopGateway
  ): string {
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

    const session: Session = { child, window, log: [], host: request.host, port }
    this.sessions.set(id, session)

    const reader = createRecordReader(
      (type, payload) => this.receive(id, session, type, payload),
      (why) => this.say(session, id, { e: 'failed', detail: `the client's output made no sense: ${why}` })
    )
    child.stdout?.on('data', (chunk: Buffer) => reader.push(chunk))

    /**
     * The client's own log, kept rather than printed.
     *
     * It goes to a file only when someone asks for it. What matters here is
     * that the last lines survive the process that wrote them: a session that
     * fails has usually said why, one line before it stopped.
     */
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        session.log.push(line)
        if (session.log.length > LOG_LINES) session.log.shift()
      }
    })

    child.on('exit', (code) => {
      this.sessions.delete(id)
      this.say(session, id, {
        e: 'closed',
        detail:
          code === 0
            ? 'the session ended'
            : `the desktop client stopped (${code ?? 'killed'})`
      })
    })
    child.on('error', (err: Error) => {
      this.sessions.delete(id)
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
    if (!session) return
    this.write(id, { a: 'stop' })
    // Closing the pipe is the backstop, the same one the shadow host has: the
    // client exits on end-of-input whether or not the message arrived.
    session.child.stdin?.end()
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }

  /** What the client said about itself, for saving beside the session logs. */
  logFor(id: string): string[] {
    return this.sessions.get(id)?.log ?? []
  }

  private write(id: string, fields: Record<string, string | number | boolean | undefined>): void {
    const session = this.sessions.get(id)
    session?.child.stdin?.write(encodeCommand(fields))
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
