import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { X509Certificate } from 'crypto'
import { app, clipboard, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { askAboutCertificate } from './certificateVerifier'
import { isUnlocked, requireUnlocked } from '../vault/locked'
import { createRecordReader, encodeCommand, readCursor, readFrame, RECORD } from './recordStream'
import { complaintIn, failureText } from './clientLog'
import { ClipboardDownload, cleanClipboardDownloads } from './ClipboardDownload'
import { pathsToUris, readFileClipboard, writeClipboardFiles } from './clipboardFiles'

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
 * See resources/freerdp/shim/ for the other end, and
 * docs/history/PLAN-freerdp.md for why any of this exists.
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
  /** The administrative session rather than an ordinary one (`/admin`). */
  admin?: boolean
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
  ready?: boolean
  /** Which local clipboard change this desktop was last sent; see `clipboardChange`. */
  clipboardSent?: number
  /**
   * Whether its pane is on screen, as the window last said. A desktop in a tab
   * nobody is looking at is not where a paste is meant; see mayReceiveClipboard.
   */
  hidden?: boolean
  download?: ClipboardDownload
  /** Files this desktop copied, fetched while it was not in use; see publishFiles. */
  filesWaiting?: { paths: string[]; epoch: number }
  clipboardManifestTimer?: NodeJS.Timeout
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

/** How long a desktop client has to exit after being told to stop. */
const STOP_GRACE_MS = 5000

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

    /*
     * The client's input can fail on its own — it exited, crashed, or closed the
     * pipe — and a write already under way then reports EPIPE as an event on the
     * pipe, not as an exception at the call. With no listener that event is an
     * uncaught exception, and it took the whole application down with the one
     * desktop. The session is ended instead; its exit says the rest.
     */
    child.stdin?.on('error', (err: Error) => {
      trace(`${id} input pipe failed: ${err.message}`)
      session.stopping = true
      if (child.exitCode === null) child.kill()
    })

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
      clearTimeout(session.clipboardManifestTimer)
      session.download?.cancel()
      this.sessions.delete(id)
      this.watchClipboard()
      this.say(session, id, {
        e: 'closed',
        detail:
          code === 0 ? 'the session ended' : `the desktop client stopped (${code ?? 'killed'})`
      })
    })
    child.on('error', (err: Error) => {
      clearTimeout(session.clipboardManifestTimer)
      session.download?.cancel()
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
      admin: request.admin,
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
    const session = this.sessions.get(id)
    if (session && fields.a === 'visible') session.hidden = fields.value === false
    this.write(id, fields)
  }

  stop(id: string): void {
    const session = this.sessions.get(id)
    if (!session || session.stopping) return
    clearTimeout(session.clipboardManifestTimer)
    session.download?.cancel()
    this.write(id, { a: 'stop' })
    // Marked before the pipe is closed, not after: everything that writes goes
    // through one place and that place refuses a session in this state.
    session.stopping = true
    // Closing the pipe is the backstop: the client exits on end-of-input
    // whether or not the message arrived.
    session.child.stdin?.end()
    /*
     * And this is the backstop for the backstop. A client stuck in a call that
     * never returns reads neither the message nor the end of its input, and the
     * process stayed behind after its pane had gone. Given a few seconds to
     * finish, it is then ended.
     */
    const kill = setTimeout(() => {
      if (session.child.exitCode === null) session.child.kill()
    }, STOP_GRACE_MS)
    kill.unref?.()
    session.child.once?.('exit', () => clearTimeout(kill))
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
    cleanClipboardDownloads()
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
  private lastClipboardVersion = ''
  private clipboardTimer: NodeJS.Timeout | undefined

  private clipboardEpoch = 0
  private clipboardPolling = false
  private clipboardPublishing = false
  private nextFilesPoll = 0

  private cancelClipboardDownloads(): void {
    this.clipboardEpoch++
    for (const [id, session] of this.sessions) {
      if (session.download?.active || session.filesWaiting)
        this.say(session, id, { e: 'clipboard-transfer', state: 'cancelled' })
      session.filesWaiting = undefined
      clearTimeout(session.clipboardManifestTimer)
      session.download?.cancel()
    }
  }

  private watchClipboard(): void {
    const wanted = [...this.sessions.values()].some((s) => s.clipboard && !s.stopping)
    if (!wanted) {
      if (this.clipboardTimer) clearInterval(this.clipboardTimer)
      this.clipboardTimer = undefined
      return
    }
    if (this.clipboardTimer) return
    this.nextFilesPoll = 0
    this.clipboardTimer = setInterval(() => void this.pollClipboard(), CLIPBOARD_POLL_MS)
    this.clipboardTimer.unref?.()
  }

  /**
   * Whether this desktop may be handed the local clipboard right now.
   *
   * Only while the vault is open and only while its window has the focus.
   * Without either condition, whatever anybody copied anywhere on this machine
   * went on arriving at every open desktop four times a second — a password
   * copied out of a password manager after TerminalDeck was locked and left,
   * included. With them, the clipboard crosses when the person is here and
   * looking at this application, which is the moment a paste could be meant.
   * A desktop that missed a change is handed it once its window is back.
   *
   * And only while its pane is on screen. The window having the focus said
   * nothing about which of its desktops was being used: one in a background
   * tab — another network, another customer — went on being handed everything
   * copied while somebody worked in the tab next to it. It is brought up to
   * date when its tab is shown again.
   */
  private mayReceiveClipboard(session: Session): boolean {
    return (
      session.clipboard &&
      Boolean(session.ready) &&
      !session.stopping &&
      !session.hidden &&
      !session.window.isDestroyed() &&
      session.window.isFocused()
    )
  }

  /**
   * Counts changes to the local clipboard. A desktop remembers the count it was
   * last sent, so one that was out of focus for a change can be brought up to
   * date when it comes back, without being sent the same thing twice.
   */
  private clipboardChange = 0

  /**
   * Whether this desktop may put what it copied onto this machine's clipboard.
   *
   * The same two conditions as the other direction. A desktop in a background
   * pane, or one left open while somebody works in another application, went on
   * replacing the local clipboard whenever anything on it copied — so a paste
   * elsewhere could bring in whatever that machine had last selected. What a
   * desktop copies now arrives while its window is the one being used.
   */
  private mayGiveClipboard(session: Session): boolean {
    return (
      session.clipboard &&
      !session.stopping &&
      !session.hidden &&
      isUnlocked() &&
      !session.window.isDestroyed() &&
      session.window.isFocused()
    )
  }

  /** Whether the local clipboard has been taken back from the desktops for the lock. */
  private clipboardWithdrawn = false

  /**
   * Takes the local clipboard back from every desktop when the vault locks.
   *
   * Stopping the poll stops new copies from going out, but a desktop still held
   * the last text and file list it was offered, and went on handing them to
   * anything on that machine that asked — files included, read from this disk on
   * request. Each desktop is now offered an empty clipboard, which is what it
   * then serves, and any download from a desktop in progress is cancelled. On
   * unlock, each is offered the local clipboard afresh.
   */
  private withdrawClipboard(): void {
    if (this.clipboardWithdrawn) return
    this.clipboardWithdrawn = true
    this.cancelClipboardDownloads()
    for (const [id, session] of this.sessions) {
      if (!session.clipboard || !session.ready || session.stopping) continue
      this.write(id, { a: 'clipset', text: '', uris: '' })
      session.clipboardSent = undefined
    }
  }

  private async pollClipboard(): Promise<void> {
    // Before anything else, the lock: a download being published used to make
    // the poll return early, and a vault locked meanwhile was not acted on until
    // the publishing was over — which it then finished.
    if (!isUnlocked()) {
      this.withdrawClipboard()
      return
    }
    if (this.clipboardPolling || this.clipboardPublishing) return
    this.clipboardWithdrawn = false
    // Files that finished arriving while their desktop was out of use go out
    // now that it is back — before the read below, which would otherwise see
    // them as a change of its own.
    for (const [id, session] of this.sessions) {
      const waiting = session.filesWaiting
      if (waiting && this.mayGiveClipboard(session)) {
        void this.publishFiles(id, session, waiting.paths, waiting.epoch)
        return
      }
    }
    if (![...this.sessions.values()].some((s) => this.mayReceiveClipboard(s))) return
    this.clipboardPolling = true
    const epoch = this.clipboardEpoch
    try {
      const text = clipboard.readText()
      let files = this.lastClipboardFiles
      let version = this.lastClipboardVersion
      if (Date.now() >= this.nextFilesPoll || text !== this.lastClipboardText) {
        const snapshot = await readFileClipboard()
        files = pathsToUris(snapshot.paths)
        version = snapshot.version
        this.nextFilesPoll = Date.now() + 1000
      }
      // A remote update or another local copy overtook the native read.
      if (epoch !== this.clipboardEpoch || text !== clipboard.readText()) return
      const changed =
        text !== this.lastClipboardText ||
        files !== this.lastClipboardFiles ||
        (this.lastClipboardVersion !== '' && version !== this.lastClipboardVersion)
      if (changed) {
        this.cancelClipboardDownloads()
        this.clipboardChange++
      }
      this.lastClipboardText = text
      this.lastClipboardFiles = files
      this.lastClipboardVersion = version
      // Locked in the time the native read took: nothing goes out after all.
      if (!isUnlocked()) return
      for (const [id, session] of this.sessions) {
        if (!this.mayReceiveClipboard(session)) continue
        if (session.clipboardSent !== this.clipboardChange) {
          this.write(id, { a: 'clipset', text, uris: files })
          session.clipboardSent = this.clipboardChange
        }
      }
    } catch (error) {
      // Native clipboard ownership can change while it is read. Retry on the next poll.
      trace(`clipboard read failed: ${String(error)}`)
    } finally {
      this.clipboardPolling = false
    }
  }

  private beginClipboardDownload(id: string, session: Session, manifest: Buffer): void {
    this.cancelClipboardDownloads()
    const epoch = this.clipboardEpoch
    let lastReport = 0
    session.download = new ClipboardDownload(
      (fields) => this.write(id, fields),
      (paths) => void this.publishFiles(id, session, paths, epoch),
      (received, total, error) => {
        if (!error && received < total && Date.now() - lastReport < 100) return
        lastReport = Date.now()
        this.say(session, id, {
          e: 'clipboard-transfer',
          state: error ? 'error' : 'receiving',
          received,
          total,
          detail: error
        })
      }
    )
    session.download.start(manifest)
  }

  /**
   * Puts the files a desktop copied onto this machine's clipboard — now, if
   * the desktop is still the one being used, or else once it is again.
   *
   * A transfer can take a while, and the person who started it may have gone
   * to another tab or application meanwhile. Publishing then broke the rule
   * the transfer began under — a desktop's copy arrives while its window is
   * the one in use — and a paste somewhere else could bring in its files. The
   * files wait instead, and the poll puts them out when the pane is on screen
   * and focused again. Anything copied locally in between, or a lock, drops
   * them, as it would a transfer still running.
   */
  private async publishFiles(
    id: string,
    session: Session,
    paths: string[],
    epoch: number
  ): Promise<void> {
    session.filesWaiting = undefined
    if (epoch !== this.clipboardEpoch || session.stopping) return
    if (!isUnlocked()) {
      this.say(session, id, { e: 'clipboard-transfer', state: 'cancelled' })
      return
    }
    if (!this.mayGiveClipboard(session)) {
      session.filesWaiting = { paths, epoch }
      return
    }
    this.clipboardPublishing = true
    try {
      // Do not overwrite a newer local copy with a transfer that took seconds.
      const snapshot = await readFileClipboard()
      const files = pathsToUris(snapshot.paths)
      // Asked again after the wait, not only before it: the vault may
      // have locked while the local clipboard was being read.
      if (
        epoch !== this.clipboardEpoch ||
        session.stopping ||
        !isUnlocked() ||
        clipboard.readText() !== this.lastClipboardText ||
        files !== this.lastClipboardFiles ||
        (this.lastClipboardVersion !== '' && snapshot.version !== this.lastClipboardVersion)
      ) {
        this.say(session, id, { e: 'clipboard-transfer', state: 'cancelled' })
        return
      }
      // And whether it is still the desktop in use: that can change during
      // the read too, and then the files wait rather than go out.
      if (!this.mayGiveClipboard(session)) {
        session.filesWaiting = { paths, epoch }
        return
      }
      const version = await writeClipboardFiles(paths, snapshot.version)
      if (version === undefined) {
        this.say(session, id, { e: 'clipboard-transfer', state: 'cancelled' })
        return
      }
      this.lastClipboardVersion = version
      this.lastClipboardFiles = pathsToUris(paths)
      this.lastClipboardText = clipboard.readText()
      this.say(session, id, { e: 'clipboard-transfer', state: 'ready' })
    } catch (error) {
      this.say(session, id, {
        e: 'clipboard-transfer',
        state: 'error',
        detail: String(error)
      })
    } finally {
      this.clipboardPublishing = false
    }
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

    /*
     * The other direction pauses with the lock as well. A desktop left open
     * behind a locked TerminalDeck is somebody else's to type into for as long
     * as nobody is here, and what it copies has no business landing on this
     * machine's clipboard while so.
     */
    if (type === RECORD.clipboardReset) {
      if (session.clipboard) {
        this.cancelClipboardDownloads()
        if (payload[0] === 1 && this.mayGiveClipboard(session)) {
          this.say(session, id, {
            e: 'clipboard-transfer',
            state: 'receiving',
            received: 0,
            total: 0
          })
          session.clipboardManifestTimer = setTimeout(() => {
            this.say(session, id, {
              e: 'clipboard-transfer',
              state: 'error',
              detail: 'The RDP server did not send the file list'
            })
          }, 30000)
        }
      }
      return
    }
    if (type === RECORD.clipboardFiles) {
      if (this.mayGiveClipboard(session)) this.beginClipboardDownload(id, session, payload)
      return
    }
    if (type === RECORD.clipboardChunk) {
      if (session.clipboard) session.download?.receive(payload)
      return
    }

    if (type === RECORD.clipboard) {
      if (!this.mayGiveClipboard(session)) return
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
      this.lastClipboardFiles = ''
      this.lastClipboardVersion = ''
      this.nextFilesPoll = 0
      return
    }

    if (type !== RECORD.event) return

    let event: Record<string, unknown>
    try {
      event = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
    } catch {
      return
    }

    if (event.e === 'connected') {
      session.ready = true
      this.nextFilesPoll = 0
      void this.pollClipboard()
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
