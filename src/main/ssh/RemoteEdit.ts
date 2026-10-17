import { shell, type BrowserWindow } from 'electron'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import { mkdtempSync, existsSync, statSync, rmSync, watch, type FSWatcher } from 'fs'
import { tmpdir } from 'os'
import { IPC } from '../../shared/ipc-channels'
import { sftpManager } from './SFTPManager'
import { localChild, safeLocalName } from '../localName'

interface EditSession {
  connectionId: string
  remotePath: string
  localPath: string
  watcher: FSWatcher
  /** Guards against re-uploading a file we just wrote ourselves. */
  uploading: boolean
  /** A save that arrived while the previous one was still going up. */
  savedAgain: boolean
  lastMtimeMs: number
  timer?: NodeJS.Timeout
  /** The upload under way, for a flush to wait on. */
  inflight?: Promise<void>
  /** Told when a save is sent, or kept because it could not be. */
  win: BrowserWindow
}

/** Splits a command line into program and arguments, honouring quoted paths. */
function parseCommand(input: string): { program: string; args: string[] } {
  const tokens: string[] = []
  let token = ''
  let quote: string | undefined
  let started = false
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = undefined
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token)
      token = ''
      started = false
    } else {
      token += char
      started = true
    }
  }
  if (quote) throw new Error('Unclosed quote in the external editor setting')
  if (started) tokens.push(token)
  return { program: tokens[0] ?? '', args: tokens.slice(1) }
}

/**
 * The editor used when none is configured: a text editor, by name.
 *
 * This used to be whatever the system opens the file with, and that is not an
 * editor. A remote file called `deploy.cmd`, `setup.js` or `tool.py` handed to
 * Windows that way is run, not opened — by the shell, by Windows Script Host,
 * by the Python launcher — and a download carries no mark that would make
 * Windows ask first. "Edit locally" on a hostile server was one click from
 * running its code here. So the default names a text editor instead: Notepad
 * on Windows, and on macOS `open -t`, the text editor the user chose there,
 * which a `.command` file cannot talk its way past either.
 *
 * Linux keeps the desktop's own handler. The copy is written without the
 * execute bit, so a script found there is opened, not run.
 */
export function defaultEditor(
  platform: NodeJS.Platform
): { program: string; args: string[] } | undefined {
  if (platform === 'win32') {
    // A full path: a bare name is looked for in the working directory first.
    const windows = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    return { program: join(windows, 'System32', 'notepad.exe'), args: [] }
  }
  if (platform === 'darwin') return { program: '/usr/bin/open', args: ['-t'] }
  return undefined
}

/**
 * Launches the configured editor, or the default one when none is set.
 * The command is split and run directly rather than through a shell, so a path
 * with spaces or shell characters cannot turn into something executable.
 */
export async function openInEditor(
  localPath: string,
  editorCommand?: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const configured = editorCommand?.trim()
  const fallback = configured ? undefined : defaultEditor(platform)
  if (!configured && !fallback) {
    const failure = await shell.openPath(localPath)
    if (failure) throw new Error(failure)
    return
  }

  const { program, args } = fallback ?? parseCommand(configured!)
  if (!program) throw new Error('The external editor setting is empty')

  // A function, not the path itself, as the replacement: in a replacement
  // string `$&` and `$'` are patterns, and a remote file may well have a
  // dollar sign in its name.
  const finalArgs = args.some((a) => a.includes('{file}'))
    ? args.map((a) => a.replaceAll('{file}', () => localPath))
    : [...args, localPath]

  await new Promise<void>((resolve, reject) => {
    // Detached so the editor outlives this handle and keeps running if we exit.
    const child = spawn(program, finalArgs, { detached: true, stdio: 'ignore' })
    child.once('error', (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `Editor not found: ${program}. Use its full path — a GUI app does not inherit your shell PATH.`
            : err.message
        )
      )
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/**
 * Opens a remote file for editing, then pushes it back whenever it is saved.
 * Editors commonly write via a temporary file and rename, so the directory is
 * watched rather than the file itself.
 */
class RemoteEditManager {
  private sessions = new Map<string, EditSession>()
  /**
   * Every temporary directory made for an edit, kept apart from the sessions.
   *
   * A session ends when its connection does, and its entry goes with it — but
   * the copy on disk does not: the editor may still have the file open, and
   * pulling it away mid-edit would be worse than leaving it. So the directory
   * is remembered here instead, and this is what the clean-up at quit walks.
   * Walking the sessions meant that anything whose connection had closed first
   * — which is most of them, since a tab is usually shut long before the app —
   * was never removed at all.
   */
  private dirs = new Set<string>()

  /**
   * Opens still downloading, by key. A second "Edit locally" on the same file
   * before the first had finished made a second copy and a second session over
   * the first — and the first copy's editor then saved into a session watching
   * the other one, so its edits never reached the server.
   */
  private opening = new Map<string, Promise<string>>()
  private openingTokens = new Map<string, { connectionId: string; cancelled: boolean }>()

  private key(connectionId: string, remotePath: string): string {
    return `${connectionId}:${remotePath}`
  }

  async open(
    win: BrowserWindow,
    connectionId: string,
    remotePath: string,
    editorCommand?: string
  ): Promise<string> {
    const key = this.key(connectionId, remotePath)
    const inFlight = this.opening.get(key)
    if (inFlight) {
      const localPath = await inFlight
      if (!this.sessions.has(key)) throw new Error('SSH connection closed while opening the editor')
      await openInEditor(localPath, editorCommand)
      return localPath
    }
    const token = { connectionId, cancelled: false }
    this.openingTokens.set(key, token)
    const opening = this.begin(win, key, connectionId, remotePath, token, editorCommand)
    this.opening.set(key, opening)
    try {
      return await opening
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key)
      if (this.openingTokens.get(key) === token) this.openingTokens.delete(key)
    }
  }

  private async begin(
    win: BrowserWindow,
    key: string,
    connectionId: string,
    remotePath: string,
    token: { cancelled: boolean },
    editorCommand?: string
  ): Promise<string> {
    const existing = this.sessions.get(key)
    if (existing) {
      await openInEditor(existing.localPath, editorCommand)
      return existing.localPath
    }

    /*
     * The last segment of a remote path is not a safe local name. On a Unix
     * server `..\..\x` is one file, and `join` on Windows walked it out of the
     * temporary directory and wrote the download wherever it pointed. Repaired
     * first, and then checked against the directory anyway, so a case the
     * repair missed is refused rather than written.
     */
    const name = safeLocalName(remotePath.split('/').pop() ?? '')
    const dir = mkdtempSync(join(tmpdir(), 'terminaldeck-edit-'))
    this.dirs.add(dir)
    const localPath = localChild(dir, name)

    await sftpManager.download(connectionId, remotePath, localPath)
    if (token.cancelled || win.isDestroyed()) {
      throw new Error('SSH connection closed while downloading the file for editing')
    }

    const session: EditSession = {
      connectionId,
      remotePath,
      localPath,
      uploading: false,
      savedAgain: false,
      lastMtimeMs: statSync(localPath).mtimeMs,
      win,
      watcher: watch(dir, () => this.onChanged(win, key))
    }
    /*
     * A watcher reports trouble as an event, and one nobody listens for is an
     * uncaught exception in the main process. Windows raises one when the
     * watched directory is deleted — a disk clean-up emptying the temporary
     * folder is enough — and the whole application went down with it.
     */
    session.watcher.on('error', () => this.stop(connectionId, remotePath))
    this.sessions.set(key, session)

    try {
      await openInEditor(localPath, editorCommand)
    } catch (err) {
      // Nothing is watching a file no editor ever opened.
      this.stop(connectionId, remotePath)
      throw err
    }
    return localPath
  }

  private onChanged(win: BrowserWindow, key: string): void {
    const session = this.sessions.get(key)
    if (!session) return

    /**
     * A save during an upload is remembered, not dropped.
     *
     * This used to return here and nothing looked again, so saving twice over a
     * slow link sent the first version and silently kept the second to itself —
     * the editor says saved, the far end has the older file, and nothing on
     * either side says otherwise. That is the worst shape a bug can take in
     * something that edits files.
     */
    if (session.uploading) {
      session.savedAgain = true
      return
    }

    // Editors often touch the file several times per save; settle first.
    clearTimeout(session.timer)
    session.timer = setTimeout(() => {
      session.timer = undefined
      void this.upload(win, key).catch((err) => console.error('[remote edit]', err))
    }, 300)
  }

  private upload(win: BrowserWindow, key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) return Promise.resolve()
    const run = this.send(win, key, session).finally(() => {
      if (session.inflight === run) session.inflight = undefined
    })
    session.inflight = run
    return run
  }

  private async send(win: BrowserWindow, key: string, session: EditSession): Promise<void> {
    if (!existsSync(session.localPath)) return

    try {
      const mtimeMs = statSync(session.localPath).mtimeMs
      if (mtimeMs === session.lastMtimeMs) return
      session.uploading = true
      await sftpManager.upload(session.connectionId, session.localPath, session.remotePath)
      session.lastMtimeMs = mtimeMs
      if (!win.isDestroyed()) {
        win.webContents.send(`${IPC.sftpEdited}:${session.connectionId}`, {
          remotePath: session.remotePath,
          savedAt: Date.now()
        })
      }
    } catch (err) {
      if (!win.isDestroyed()) {
        win.webContents.send(`${IPC.sftpEdited}:${session.connectionId}`, {
          remotePath: session.remotePath,
          error: (err as Error).message
        })
      }
    } finally {
      session.uploading = false
    }

    // Whatever was saved while this one was in flight goes now. The mtime check
    // at the top means a spurious wake-up costs nothing.
    if (session.savedAgain) {
      session.savedAgain = false
      this.onChanged(win, key)
    }
  }

  /**
   * Whether something saved in the editor has not reached the server: the copy
   * is newer than the last one sent. A pending wait, an upload under way or a
   * save made during one all show up here, and a wake-up that changed nothing
   * does not.
   */
  private unsynced(session: EditSession): boolean {
    try {
      return statSync(session.localPath).mtimeMs !== session.lastMtimeMs
    } catch {
      return false
    }
  }

  /** Whether any edit — or any on this connection — is still to be sent. */
  hasUnsynced(connectionId?: string): boolean {
    return [...this.sessions.values()].some(
      (s) => (!connectionId || s.connectionId === connectionId) && this.unsynced(s)
    )
  }

  /**
   * Sends what was saved and not yet sent, now, and waits for it — for the
   * moment a connection, the window or the application is about to go.
   *
   * A save waits 300 ms for the editor to finish writing, and the connection
   * closing in that time cleared the wait: saving and quitting at once kept
   * the old file on the server and deleted the new one here. Gives up after
   * `limitMs`; whatever is still unsent then is kept rather than deleted.
   */
  async flush(limitMs: number, connectionId?: string): Promise<void> {
    const pending = [...this.sessions.entries()].filter(
      ([, s]) => (!connectionId || s.connectionId === connectionId) && this.unsynced(s)
    )
    const work = Promise.all(
      pending.map(async ([key, session]) => {
        // A save made during the upload is sent after it; a few rounds at most.
        for (let round = 0; round < 5; round++) {
          if (this.sessions.get(key) !== session || !this.unsynced(session)) return
          clearTimeout(session.timer)
          session.timer = undefined
          if (session.inflight) await session.inflight
          else await this.upload(session.win, key)
        }
      })
    )
    let timer: NodeJS.Timeout | undefined
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limitMs)
    })
    await Promise.race([work, limit])
    clearTimeout(timer)
  }

  /** Copies kept because what was saved in them never reached the server. */
  private kept = new Map<string, string>()

  /**
   * Copies whose session has ended, by directory, with when they were last
   * sent. The editor is somebody else's program and outlives the tab: a save
   * made in it after its connection closed reaches nobody, and the copy it
   * went into was then deleted at quit with that save in it.
   */
  private released = new Map<string, { localPath: string; sentMtimeMs: number }>()

  /**
   * Lets a session go. One holding an unsent save keeps its copy — the only
   * place that save now exists — and the window is told where it is.
   */
  private release(key: string, session: EditSession): void {
    clearTimeout(session.timer)
    session.watcher.close()
    this.sessions.delete(key)
    if (!this.unsynced(session)) {
      this.released.set(dirname(session.localPath), {
        localPath: session.localPath,
        sentMtimeMs: session.lastMtimeMs
      })
      return
    }
    this.kept.set(dirname(session.localPath), session.localPath)
    if (!session.win.isDestroyed()) {
      session.win.webContents.send(`${IPC.sftpEdited}:${session.connectionId}`, {
        remotePath: session.remotePath,
        error: `Not uploaded. The edited copy is kept at ${session.localPath}`
      })
    }
  }

  stop(connectionId: string, remotePath: string): void {
    const key = this.key(connectionId, remotePath)
    const token = this.openingTokens.get(key)
    if (token) token.cancelled = true
    const session = this.sessions.get(key)
    if (!session) return
    this.release(key, session)
  }

  /**
   * Deletes the copies, on the way out.
   *
   * Every file opened for editing is downloaded into a temporary directory of
   * its own, and nothing removed them — so a remote `sshd_config`, or anything
   * else worth editing over SSH, was left lying in plain text under the
   * system's temporary directory. macOS and Linux clear that eventually;
   * Windows does not.
   *
   * Done at quit rather than when a file is closed, because the editor is
   * somebody else's program and this end cannot tell when they have finished
   * with it. After quit there is nothing left to upload to, so a copy that
   * stays is all cost and no use — unless it holds a save that never reached
   * the server, which is kept, and returned for the person to be told.
   */
  cleanUp(): string[] {
    for (const token of this.openingTokens.values()) token.cancelled = true
    for (const [key, session] of [...this.sessions]) this.release(key, session)

    // Saved in an editor after its connection had gone: kept, like the rest.
    for (const [dir, { localPath, sentMtimeMs }] of this.released) {
      try {
        if (statSync(localPath).mtimeMs !== sentMtimeMs) this.kept.set(dir, localPath)
      } catch {
        // Gone already; nothing to keep.
      }
    }
    this.released.clear()

    // Every directory ever made, not only the ones still being watched.
    for (const dir of this.dirs) {
      if (this.kept.has(dir)) continue
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // A file still held open, or a directory already gone. Not worth
        // delaying a quit over, and the next boot clears it on two platforms
        // out of three.
      }
    }
    this.dirs.clear()
    const kept = [...this.kept.values()]
    this.kept.clear()
    return kept
  }

  /** Which temporary directories are still on disk, for the test to look at. */
  temporaryDirs(): string[] {
    return [...this.dirs]
  }

  /** Called when a connection goes away: its watchers are pointless afterwards. */
  stopAllFor(connectionId: string): void {
    for (const token of this.openingTokens.values()) {
      if (token.connectionId === connectionId) token.cancelled = true
    }
    for (const [key, session] of [...this.sessions]) {
      if (session.connectionId === connectionId) this.release(key, session)
    }
  }

  list(connectionId: string): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.connectionId === connectionId)
      .map((s) => s.remotePath)
  }
}

export const remoteEdit = new RemoteEditManager()
