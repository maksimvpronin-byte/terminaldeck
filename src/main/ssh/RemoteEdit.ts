import { shell, type BrowserWindow } from 'electron'
import { dirname, join } from 'path'
import { spawn } from 'child_process'
import { mkdtempSync, existsSync, statSync, rmSync, watch, type FSWatcher } from 'fs'
import { tmpdir } from 'os'
import { IPC } from '../../shared/ipc-channels'
import { sftpManager } from './SFTPManager'

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
}

/** Splits a command line into program and arguments, honouring quoted paths. */
function parseCommand(input: string): { program: string; args: string[] } {
  const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const clean = tokens.map((t) => t.replace(/^["']|["']$/g, ''))
  return { program: clean[0] ?? '', args: clean.slice(1) }
}

/**
 * Launches the configured editor, or hands the file to the OS when none is set.
 * The command is split and run directly rather than through a shell, so a path
 * with spaces or shell characters cannot turn into something executable.
 */
async function openInEditor(localPath: string, editorCommand?: string): Promise<void> {
  if (!editorCommand?.trim()) {
    const failure = await shell.openPath(localPath)
    if (failure) throw new Error(failure)
    return
  }

  const { program, args } = parseCommand(editorCommand.trim())
  if (!program) throw new Error('The external editor setting is empty')

  const finalArgs = args.some((a) => a.includes('{file}'))
    ? args.map((a) => a.replace('{file}', localPath))
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
    const existing = this.sessions.get(key)
    if (existing) {
      await openInEditor(existing.localPath, editorCommand)
      return existing.localPath
    }

    const name = remotePath.split('/').pop() || 'file'
    const dir = mkdtempSync(join(tmpdir(), 'terminaldeck-edit-'))
    const localPath = join(dir, name)

    await sftpManager.download(connectionId, remotePath, localPath)

    const session: EditSession = {
      connectionId,
      remotePath,
      localPath,
      uploading: false,
      savedAgain: false,
      lastMtimeMs: statSync(localPath).mtimeMs,
      watcher: watch(dir, () => this.onChanged(win, key))
    }
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
    session.timer = setTimeout(() => void this.upload(win, key), 300)
  }

  private async upload(win: BrowserWindow, key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session || !existsSync(session.localPath)) return

    const mtimeMs = statSync(session.localPath).mtimeMs
    if (mtimeMs === session.lastMtimeMs) return

    session.uploading = true
    try {
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

  stop(connectionId: string, remotePath: string): void {
    const key = this.key(connectionId, remotePath)
    const session = this.sessions.get(key)
    if (!session) return
    clearTimeout(session.timer)
    session.watcher.close()
    this.sessions.delete(key)
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
   * stays is all cost and no use.
   */
  cleanUp(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer)
      session.watcher.close()
      try {
        rmSync(dirname(session.localPath), { recursive: true, force: true })
      } catch {
        // A file still held open, or a directory already gone. Not worth
        // delaying a quit over, and the next boot clears it on two platforms
        // out of three.
      }
    }
    this.sessions.clear()
  }

  /** Called when a connection goes away: its watchers are pointless afterwards. */
  stopAllFor(connectionId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.connectionId !== connectionId) continue
      clearTimeout(session.timer)
      session.watcher.close()
      this.sessions.delete(key)
    }
  }

  list(connectionId: string): string[] {
    return [...this.sessions.values()]
      .filter((s) => s.connectionId === connectionId)
      .map((s) => s.remotePath)
  }
}

export const remoteEdit = new RemoteEditManager()
