import { forEachConcurrent } from './parallel'
import { ScpShell } from './ScpShell'
import type { Writable } from 'stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import { readdir, mkdir, stat, lstat, readFile, open as openLocal } from 'fs/promises'
import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync
} from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, isAbsolute, join, relative, sep } from 'path'
import { sshManager } from './SSHManager'
import { localChild, remoteChild } from '../localName'
import {
  buildTransferPlan,
  conflictedPaths,
  shouldWrite,
  type DestInfo
} from '../../shared/transferPlan'
import { baseNameOf, joinRemote, parentOf } from '../../shared/remotePath'
import { parseLongnameOwner } from '../../shared/permissions'
import { SEARCH_LIMIT, globFor, nameMatcher } from '../../shared/fileSearch'
import type {
  FileComparison,
  SftpEntry,
  SftpSearchResult,
  TransferDecisions,
  TransferItem,
  TransferPlan,
  TransferResult
} from '../../shared/types'

type ProgressFn = (transferred: number, total: number, path: string) => void

const NO_DECISIONS: TransferDecisions = {}

/**
 * Past this, a file is not diffed. Reading a 200 MB log into the renderer to
 * compare it line by line would lock the window for an answer nobody wants in
 * that form.
 */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/** An SFTP request with a plain callback, as a promise. */
function sftpCall(start: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => start((err) => (err ? reject(err) : resolve())))
}

/** lstat that answers null for "not there" and throws for anything else. */
function lstatRaw(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (err, stats) => {
      if (!err) return resolve(stats)
      const code = (err as { code?: number }).code
      if (code === 2 || /no such file/i.test(err.message)) resolve(null)
      else reject(err)
    })
  })
}

/**
 * A hidden name beside `path` for a copy still on its way there. Beside it and
 * not in /tmp, because a rename only replaces a file within one filesystem.
 *
 * Random rather than counted. The name used to be the process id and a
 * counter, which anyone else who can write to the directory could guess and
 * put a link at before the upload arrived.
 */
export function partialNameFor(path: string): string {
  return joinRemote(
    parentOf(path),
    `.${baseNameOf(path)}.td-partial-${randomBytes(8).toString('hex')}`
  )
}

/** A download's destination was taken while the download was on its way. */
export class DestinationAppeared extends Error {
  constructor(readonly path: string) {
    super(`${path} appeared during the download and was left alone`)
  }
}

/**
 * Puts a finished download at `dest` only if nothing is there.
 *
 * A rename would do it in one step, but a rename replaces, and a file that
 * turned up at `dest` while the download ran — never seen by the plan, never
 * asked about — went with it. A hard link is refused if the name is taken, and
 * is as atomic as the rename; a copy made with COPYFILE_EXCL stands in on the
 * drives that have no hard links (FAT, exFAT, some network shares).
 */
function placeWithoutReplacing(partial: string, dest: string): void {
  try {
    linkSync(partial, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new DestinationAppeared(dest)
    try {
      copyFileSync(partial, dest, constants.COPYFILE_EXCL)
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DestinationAppeared(dest)
      }
      throw copyErr
    }
  }
  rmSync(partial, { force: true })
}

/** The mode a copy on its way is kept at, whatever the file it becomes. */
const PARTIAL_MODE = 0o600

/**
 * Gives a finished download the mode it is to end with: that of the file it
 * replaces, or the one a new file gets here.
 *
 * The rename used to take the partial's mode along with its contents, so a
 * 0600 file fetched again — an SSH key, a config with a password in it — came
 * back readable by everyone, and a script lost its executable bit. Through the
 * descriptor, since the name may no longer be the file's; not on Windows, where
 * a mode is a read-only flag and carrying that one onto the partial would only
 * stop the rename.
 */
function giveModeOf(dest: string, fd: number): void {
  if (process.platform === 'win32') return
  let mode: number
  try {
    mode = statSync(dest).mode & 0o7777
  } catch {
    mode = 0o666 & ~process.umask()
  }
  fchmodSync(fd, mode)
}

/**
 * A path that opens the file `fd` holds, whatever now stands at its name.
 *
 * ssh2 takes a path and opens it itself, with `w`, which follows a link. A
 * partial created exclusively is the download's own when it is created, but
 * in a folder where somebody else may delete files, the name can be swapped
 * for a link between that and ssh2's open. These name the open file instead:
 * on Linux a magic link to it, on a Mac a duplicate of the descriptor. Windows
 * has neither, and a link there needs a privilege ordinary accounts lack.
 */
function throughDescriptor(fd: number, path: string): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`
  if (process.platform === 'darwin') return `/dev/fd/${fd}`
  return path
}

/** Whether the file at `path` is no longer the one a plan found there. */
function changedSince(path: string, found: { destSize: number; destMtime: number }): boolean {
  try {
    const now = lstatSync(path)
    return now.size !== found.destSize || now.mtimeMs !== found.destMtime
  } catch {
    // Gone meanwhile: nothing is lost by putting the download there.
    return false
  }
}

/** Whether `path` still names the file `fd` holds, and not a link put there since. */
function namesHeldFile(fd: number, path: string): boolean {
  try {
    const held = fstatSync(fd, { bigint: true })
    const named = lstatSync(path, { bigint: true })
    return held.dev === named.dev && held.ino === named.ino
  } catch {
    return false
  }
}

/** The file a download was told to replace was changed while it ran. */
export class DestinationChanged extends DestinationAppeared {
  constructor(path: string) {
    super(path)
    this.message = `${path} changed during the download and was left alone`
  }
}

/** A download's partial name stood for something else by the time it was moved. */
export class PartialReplaced extends Error {
  constructor(readonly path: string) {
    super(`${path} was replaced while the download ran, and nothing was moved into place`)
  }
}

/**
 * Creates `path` for this upload alone and closes it to everyone else.
 *
 * Exclusively, so a name somebody else put down first is refused rather than
 * written through. The server's own mode for a new file is read before the
 * copy is narrowed to its owner, and returned: that is the mode a file that
 * did not exist before is given at the end, as it always was. Undefined where
 * the server would not say.
 *
 * The copy used to be created with whatever the server's umask allowed, and
 * given the protected file's mode only once every byte was in — so for the
 * length of the transfer, the new contents of a 0600 file were readable by
 * anyone who could read the directory.
 *
 * And kept open, its handle returned: everything after goes through it. The
 * copy was closed here and opened again by name to be written, and in a
 * folder somebody else could write to, the name could be swapped for a link
 * in between — root uploading into such a folder then wrote the file into
 * whatever the link named.
 */
function createPrivately(
  sftp: SFTPWrapper,
  path: string
): Promise<{ handle: Buffer; mode: number | undefined; private: boolean }> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'wx', (err, handle) => {
      if (err) return reject(err)
      sftp.fstat(handle, (statErr, stats) => {
        const mode = statErr ? undefined : stats.mode & 0o7777
        // Read back: whether the server really narrowed it is for the caller
        // to weigh against what the copy is about to hold.
        sftp.fchmod(handle, PARTIAL_MODE, () =>
          sftp.fstat(handle, (checkErr, now) =>
            resolve({ handle, mode, private: !checkErr && (now.mode & 0o077) === 0 })
          )
        )
      })
    })
  })
}

/** Pieces a local file goes up in, and how many are in flight, as ssh2's fastPut has them. */
const PUT_CHUNK = 32 * 1024
const PUT_IN_FLIGHT = 64

/**
 * Sends a local file into a remote file already open, at `handle`.
 *
 * fastPut takes a name and opens it itself, which is what a copy created and
 * held cannot afford; this writes the same way, several pieces in flight at
 * once, through the handle.
 */
async function putThroughHandle(
  sftp: SFTPWrapper,
  handle: Buffer,
  localPath: string,
  onProgress?: (transferred: number, total: number) => void
): Promise<void> {
  const file = await openLocal(localPath, 'r')
  try {
    const { size } = await file.stat()
    let next = 0
    let sent = 0
    let failed = false
    const worker = async (): Promise<void> => {
      while (!failed && next < size) {
        const start = next
        const length = Math.min(PUT_CHUNK, size - start)
        next += length
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await file.read(buffer, 0, length, start)
        if (bytesRead !== length) throw new Error(`${localPath} changed while it was being sent`)
        await sftpCall((cb) => sftp.write(handle, buffer, 0, length, start, cb))
        sent += length
        onProgress?.(sent, size)
      }
    }
    await Promise.all(
      Array.from({ length: PUT_IN_FLIGHT }, () =>
        worker().catch((err) => {
          failed = true
          throw err
        })
      )
    )
  } finally {
    await file.close()
  }
}

/**
 * Whether the server offered OpenSSH's `posix-rename`, the only rename that
 * replaces an existing file. ssh2 records the extensions it was offered, and
 * throws from the request itself when this one is missing.
 */
function supportsPosixRename(sftp: SFTPWrapper): boolean {
  const offered = (sftp as unknown as { _extensions?: Record<string, string> })._extensions
  return offered === undefined || offered['posix-rename@openssh.com'] === '1'
}

/** Text or not: the same test `grep` and `git` use — a NUL byte early on. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

/**
 * Whether a destination may still be written as the plan intended: empty if it
 * was empty, and if it held a file that somebody agreed to replace, still a
 * file — never a directory, a link or something that cannot be read.
 */
export function stillAsPlanned(
  wasOccupied: boolean,
  now: DestInfo | null,
  folder = false,
  planned?: { destSize: number; destMtime: number }
): boolean {
  if (!now) return true
  if (folder) return now.isDirectory && !now.unreadable
  if (!wasOccupied) return false
  if (now.isDirectory || now.isSymlink || now.unreadable) return false
  /*
   * The file asked about, and not another one at its name. Only "is it still
   * occupied" was asked, so a file changed while the conflict dialog was open,
   * or while the files before it went across, was overwritten with its new
   * contents on the strength of an answer about the old ones.
   */
  return !planned || (now.size === planned.destSize && now.mtime === planned.destMtime)
}

/**
 * The first link between `root` and the folder `path` is written into, if any.
 *
 * A download looked only at the file it was about to write: `logs` inside the
 * chosen folder could be a link to anywhere, and `logs/a.log` was written
 * there, with no conflict and a report of success. The chosen folder itself
 * is the person's choice and is followed; what lies below it is not. A path
 * that is not below `root` at all answers itself.
 */
export async function linkBelow(root: string, path: string): Promise<string | undefined> {
  const rel = relative(root, dirname(path))
  if (rel === '') return undefined
  // `..cache` is a folder of that name; only `..` itself, as a whole step, leaves.
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path
  let cursor = root
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part)
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return cursor
    } catch {
      // Not there yet: the download makes it, and nothing below it exists.
      return undefined
    }
  }
  return undefined
}

/** An empty folder in a plan: made at the destination, with nothing to copy into it. */
function folderItem(sourcePath: string, destPath: string, mtime: number): TransferItem {
  return { sourcePath, destPath, sourceSize: 0, sourceMtime: mtime, isDirectory: true }
}

class SFTPManager {
  private shells = new Map<string, ScpShell>()
  private getShell(connectionId: string): ScpShell | undefined {
    const access = sshManager.getFileAccess(connectionId)
    if (access?.protocol !== 'scp') return undefined
    let shell = this.shells.get(connectionId)
    if (!shell) {
      const chain = sshManager.getClientChain(connectionId)
      if (!chain?.length) throw new Error('No active SSH connection')
      shell = new ScpShell(chain[chain.length - 1], access.shell ?? '')
      this.shells.set(connectionId, shell)
    }
    return shell
  }
  private sessions = new Map<string, SFTPWrapper>()
  private opening = new Map<string, Promise<SFTPWrapper>>()
  /** Makes each in-progress download's temporary name its own. */
  private nextTransfer = 0

  private async getSftp(connectionId: string): Promise<SFTPWrapper> {
    const cached = this.sessions.get(connectionId)
    if (cached) return cached

    const chain = sshManager.getClientChain(connectionId)
    if (!chain || chain.length === 0) throw new Error('No active SSH connection')
    const target = chain[chain.length - 1]

    const pending = this.opening.get(connectionId)
    if (pending) return pending
    const opening = new Promise<SFTPWrapper>((resolve, reject) => {
      target.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
      .then((sftp) => {
        if (this.opening.get(connectionId) !== opening) {
          sftp.end()
          throw new Error('SSH connection closed while opening SFTP')
        }
        this.sessions.set(connectionId, sftp)
        return sftp
      })
      .finally(() => {
        if (this.opening.get(connectionId) === opening) this.opening.delete(connectionId)
      })
    // Every waiter shares validation and cleanup, not just the raw open callback.
    this.opening.set(connectionId, opening)
    return opening
  }

  async list(connectionId: string, remotePath: string): Promise<SftpEntry[]> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.list(remotePath)
    const sftp = await this.getSftp(connectionId)
    const entries = await new Promise<import('ssh2').FileEntry[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => (err ? reject(err) : resolve(list)))
    })
    return entries.map((e) => {
      // Names if the server's listing line has them, numbers if it does not.
      const named = parseLongnameOwner(e.longname ?? '')
      return {
        name: e.filename,
        path: remotePath.replace(/\/$/, '') + '/' + e.filename,
        isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
        isSymlink: (e.attrs.mode & 0o170000) === 0o120000,
        size: e.attrs.size ?? 0,
        mtime: (e.attrs.mtime ?? 0) * 1000,
        // 0o7777, not 0o777: setuid, setgid and the sticky bit are part of what
        // the panel shows, and /tmp reading as drwxrwxrwx would be a lie.
        permissions: (e.attrs.mode & 0o7777).toString(8),
        owner: named?.owner ?? String(e.attrs.uid ?? ''),
        group: named?.group ?? String(e.attrs.gid ?? '')
      }
    })
  }

  /**
   * Everything under `remotePath` whose name matches `query` — see
   * shared/fileSearch.ts for what matches.
   *
   * SCP/Shell hands the whole walk to `find` on the server. SFTP has nothing
   * of the kind, so the folders are listed here, a few at a time, breadth
   * first so that what is near the top is found before the walk runs out.
   * Symlinked folders are not entered, for the reason transfers skip them: one
   * can loop, or lead out of the tree. A folder that cannot be read is passed
   * over. The walk stops at the result limit or after a minute, and says so.
   */
  async find(connectionId: string, remotePath: string, query: string): Promise<SftpSearchResult> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.find(remotePath, globFor(query), SEARCH_LIMIT)
    const matches = nameMatcher(query)
    const root = await this.realpath(connectionId, remotePath)
    if (!matches) return { root, entries: [], truncated: false }

    const deadline = Date.now() + 60_000
    const entries: SftpEntry[] = []
    let truncated = false
    let level = [root]
    while (level.length > 0 && !truncated) {
      const next: string[] = []
      await forEachConcurrent(level, async (dir) => {
        if (truncated) return
        if (Date.now() > deadline) {
          truncated = true
          return
        }
        let listing: SftpEntry[]
        try {
          listing = await this.list(connectionId, dir)
        } catch {
          return
        }
        for (const entry of listing) {
          if (entry.isDirectory && !entry.isSymlink) next.push(entry.path)
          if (!matches(entry.name)) continue
          if (entries.length >= SEARCH_LIMIT) {
            truncated = true
            return
          }
          entries.push(entry)
        }
      })
      level = next
    }
    return { root, entries, truncated }
  }

  /**
   * The server's own answer for a path: resolves `~`, `.`, `..` and symlinks.
   * The panel opens on `.`, which is wherever SFTP started, and needs this to
   * show where that actually is.
   */
  async realpath(connectionId: string, remotePath: string): Promise<string> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.realpath(remotePath)
    const sftp = await this.getSftp(connectionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err, resolved) => (err ? reject(err) : resolve(resolved)))
    })
  }

  /** A stat that answers "missing" rather than throwing, for existence checks. */
  async statPath(connectionId: string, remotePath: string): Promise<SftpEntry | null> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.statPath(remotePath)
    const sftp = await this.getSftp(connectionId)
    return new Promise((resolve, reject) => {
      sftp.lstat(remotePath, (err, stats) => {
        if (err) {
          // ssh2 reports a missing file as code 2; anything else is a real fault
          // and must not be mistaken for "there is nothing there".
          const code = (err as NodeJS.ErrnoException & { code?: number }).code
          if (code === 2 || /no such file/i.test(err.message)) resolve(null)
          else reject(err)
          return
        }
        resolve({
          name: remotePath.slice(remotePath.lastIndexOf('/') + 1),
          path: remotePath,
          isDirectory: stats.isDirectory(),
          isSymlink: stats.isSymbolicLink(),
          size: stats.size,
          mtime: (stats.mtime ?? 0) * 1000,
          permissions: (stats.mode & 0o7777).toString(8),
          // lstat answers about one path and sends no listing line, so there
          // are no names to be had here — only the ids.
          owner: String(stats.uid ?? ''),
          group: String(stats.gid ?? '')
        })
      })
    })
  }

  /**
   * What a link points at, followed to the end — or undefined when it leads
   * nowhere or cannot be read.
   */
  private async targetOf(
    connectionId: string,
    remotePath: string
  ): Promise<{ isDirectory: boolean; size: number; mtime: number } | undefined> {
    try {
      const shell = this.getShell(connectionId)
      if (shell) return (await shell.statPath(remotePath, true)) ?? undefined
      const sftp = await this.getSftp(connectionId)
      return await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) =>
          err
            ? reject(err)
            : resolve({
                isDirectory: stats.isDirectory(),
                size: stats.size,
                mtime: (stats.mtime ?? 0) * 1000
              })
        )
      })
    } catch {
      return undefined
    }
  }

  async mkdir(connectionId: string, remotePath: string): Promise<void> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.mkdir(remotePath)
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * Removes a path, emptying directories first — rmdir refuses non-empty ones.
   * Symlinks are unlinked rather than followed, so a link pointing outside the
   * tree can't take its target with it.
   */
  async delete(connectionId: string, remotePath: string, isDirectory: boolean): Promise<void> {
    const shell = this.getShell(connectionId)
    const sftp = shell ? undefined : await this.getSftp(connectionId)
    if (isDirectory) {
      for (const entry of await this.list(connectionId, remotePath)) {
        await this.delete(connectionId, entry.path, entry.isDirectory && !entry.isSymlink)
      }
    }
    if (shell) return shell.remove(remotePath, isDirectory)
    await new Promise<void>((resolve, reject) => {
      const cb = (err: Error | undefined | null): void => (err ? reject(err) : resolve())
      if (isDirectory) sftp!.rmdir(remotePath, cb)
      else sftp!.unlink(remotePath, cb)
    })
  }

  async rename(connectionId: string, oldPath: string, newPath: string): Promise<void> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.rename(oldPath, newPath)
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async download(
    connectionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (transferred: number, total: number) => void,
    /**
     * Whether a file already at `localPath` may be replaced. False for one
     * that was not there when the transfer was planned: if something takes
     * the name meanwhile, it is kept and DestinationAppeared is thrown.
     */
    replace = true,
    /**
     * The file being replaced, as the plan found it. Checked again just before
     * the replacement: saved by another program while the download ran, it is
     * another file, and is kept.
     */
    expected?: { destSize: number; destMtime: number },
    /**
     * The folder the download was chosen into, whose links below it are not
     * followed; see linkBelow. Looked at again once the partial exists.
     */
    within?: string
  ): Promise<void> {
    const shell = this.getShell(connectionId)
    const sftp = shell ? undefined : await this.getSftp(connectionId)

    /**
     * Written beside the destination and moved onto it at the end.
     *
     * Straight into the destination is what `scp` does, and it means a
     * connection that drops halfway leaves a truncated file where a whole one
     * used to be — the download that was meant to fetch a copy having destroyed
     * the copy already there. The rename is atomic within a directory, so the
     * name holds the old file or the new one and never half of either.
     *
     * The unique suffix is not decoration: two panes fetching the same file
     * into the same folder would otherwise write into one another's partial.
     * Random, and the file created here exclusively and private before a byte
     * arrives: the name was the process id and a counter, and ssh2 opens what
     * it is given with `w`, which writes through a link that anyone able to
     * write to the folder had guessed and put down first. And written through
     * the descriptor rather than the name; see throughDescriptor.
     */
    const partial = `${localPath}.part-${randomBytes(8).toString('hex')}`
    const fd = openSync(partial, 'wx', PARTIAL_MODE)
    /*
     * runPlan looks for a link before it calls this, and a folder could still
     * be swapped for one between that look and the open: the file was then
     * written wherever the link pointed. Once the partial exists the open has
     * happened, so a link found now is one it went through, and it goes. One
     * put there later only stops the rename, which looks for the partial
     * through it and does not find it.
     */
    if (within && (await linkBelow(within, partial))) {
      const mine = namesHeldFile(fd, partial)
      closeSync(fd)
      if (mine) rmSync(partial, { force: true })
      throw new DestinationAppeared(localPath)
    }
    const target = throughDescriptor(fd, partial)
    let held = true
    const release = (): void => {
      if (held) closeSync(fd)
      held = false
    }
    let ours = true
    try {
      if (shell) await shell.download(remotePath, target, onProgress)
      else
        await new Promise<void>((resolve, reject) => {
          sftp!.fastGet(
            remotePath,
            target,
            {
              mode: PARTIAL_MODE,
              step: (transferred, _chunk, total) => onProgress?.(transferred, total)
            },
            (err) => (err ? reject(err) : resolve())
          )
        })
      giveModeOf(localPath, fd)
      // What is moved is the name, so it has to be ours still. Closed first:
      // Windows will not always rename a file somebody holds open.
      ours = namesHeldFile(fd, partial)
      release()
      if (!ours) throw new PartialReplaced(partial)
      if (replace && expected && changedSince(localPath, expected)) {
        throw new DestinationChanged(localPath)
      }
      if (replace) renameSync(partial, localPath)
      else placeWithoutReplacing(partial, localPath)
    } catch (err) {
      if (held) ours = namesHeldFile(fd, partial)
      release()
      // Nothing half-finished is left lying beside the file it failed to
      // become — but what somebody else put at the name is not ours to remove.
      if (ours) {
        try {
          rmSync(partial, { force: true })
        } catch {
          // Already gone.
        }
      }
      throw err
    }
  }

  /**
   * Sends a local file to the far end, through a name of its own and then into
   * place — see `writeRemoteFile` for when, and why not always.
   */
  async upload(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void,
    /** See writeRemoteFile. */
    beforeReplace?: () => Promise<void>
  ): Promise<void> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.upload(localPath, remotePath, onProgress)
    const sftp = await this.getSftp(connectionId)
    await this.writeRemoteFile(
      sftp,
      remotePath,
      (_target, handle) => putThroughHandle(sftp, handle, localPath, onProgress),
      beforeReplace
    )
  }

  /**
   * Writes a remote file so that a transfer which stops halfway leaves the file
   * that was there, not the first half of the new one — whatever the server
   * supports.
   *
   * The bytes go to a hidden name beside the destination and are moved onto it
   * at the end. A destination that did not exist is renamed into place, and if
   * something appeared there meanwhile the rename refuses and it is left alone.
   *
   * Replacing a file that exists takes more:
   *
   * - The copy is given the old file's mode, and its owner where it differs. A
   *   login that cannot give it the same owner is told so and the file is left
   *   as it was. This used to fall back to writing straight over the original,
   *   which is the one thing all of this exists to avoid, and it did so without
   *   a word: a dropped link then truncated exactly the files — someone else's,
   *   often a service's configuration — where it mattered most.
   * - OpenSSH's `posix-rename` swaps the copy in atomically. A server without it
   *   gets two renames instead: the original moved aside, the copy moved in, the
   *   original removed. The name is briefly empty, but at no moment is either
   *   file half-written, and a failed second rename moves the original back.
   *
   * A symlink stays a symlink: what it points at is replaced the same way.
   * Renaming over the link itself would turn it into a file.
   *
   * `beforeReplace` runs once the copy is ready, just before it goes over the
   * file it replaces, and throws to keep that file. The destination was
   * compared with the plan before the bytes went, and a file saved on the
   * server while they did was then swapped out all the same.
   */
  private async writeRemoteFile(
    sftp: SFTPWrapper,
    remotePath: string,
    write: (target: string, handle: Buffer) => Promise<void>,
    beforeReplace?: () => Promise<void>
  ): Promise<void> {
    let target = remotePath
    let existing = await lstatRaw(sftp, remotePath)
    if (existing?.isSymbolicLink()) {
      target = await new Promise<string>((resolve, reject) =>
        sftp.realpath(remotePath, (err, resolved) =>
          err
            ? reject(
                new Error(`${remotePath} is a link to nothing that can be written (${err.message})`)
              )
            : resolve(resolved)
        )
      )
      existing = await lstatRaw(sftp, target)
    }
    if (existing?.isDirectory()) throw new Error(`Refusing to write over the directory ${target}`)

    const n = this.nextTransfer++
    const partial = partialNameFor(target)
    let created = false
    let moved = false
    // The copy's own handle, held until it is in shape; see createPrivately.
    let held: Buffer | undefined
    /*
     * A close can be where a server says the writes did not keep, and that
     * is a failed upload, not a copy to put in place: swallowed, an
     * incomplete copy replaced the original. Only the last word, after
     * something else already failed, is let go quietly.
     */
    const letGo = async (quietly = false): Promise<void> => {
      const handle = held
      held = undefined
      if (!handle) return
      const closing = sftpCall((cb) => sftp.close(handle, cb))
      await (quietly ? closing.catch(() => undefined) : closing)
    }
    /*
     * Moved by name, so the name has to be the copy still. A link put there
     * would be renamed into the destination's place; refused, it and what it
     * names are left alone.
     */
    const stillOurs = async (): Promise<void> => {
      const now = await lstatRaw(sftp, partial)
      if (!now || !now.isFile()) {
        created = false
        throw new PartialReplaced(partial)
      }
    }
    try {
      const opened = await createPrivately(sftp, partial)
      held = opened.handle
      created = true
      /*
       * A file only its owner may read keeps its new contents to its owner
       * while they go up. A server that refused to narrow the copy had a 0600
       * key's new contents written where anyone on it could read them —
       * fastPut went on regardless too — so nothing is written into it. A
       * file open to others already, or a new one, is no secret to keep, and
       * a server that keeps no Unix modes (Windows) still takes those.
       */
      if (existing && (existing.mode & 0o077) === 0 && !opened.private) {
        throw new Error(
          `${target} was left unchanged: only its owner may read it, and the server would not keep the new copy private while it was written`
        )
      }
      await write(partial, opened.handle)
      if (!existing) {
        // What a new file here has always been given, not the copy's 0600.
        const newFileMode = opened.mode
        if (newFileMode !== undefined) {
          await sftpCall((cb) => sftp.fchmod(opened.handle, newFileMode, cb))
        }
        await letGo()
        await stillOurs()
        await sftpCall((cb) => sftp.rename(partial, target, cb)).catch((err: Error) => {
          throw new Error(
            `${target} could not be put in place (${err.message}). If something appeared there during the transfer, it was left alone.`
          )
        })
        moved = true
        return
      }

      await this.matchMetadata(sftp, opened.handle, existing, target)
      await letGo()
      await beforeReplace?.()
      await stillOurs()

      if (supportsPosixRename(sftp)) {
        await sftpCall((cb) => sftp.ext_openssh_rename(partial, target, cb))
        moved = true
        return
      }

      const aside = joinRemote(
        parentOf(target),
        `.${baseNameOf(target)}.td-previous-${process.pid}-${n}`
      )
      await sftpCall((cb) => sftp.rename(target, aside, cb))
      try {
        await sftpCall((cb) => sftp.rename(partial, target, cb))
        moved = true
      } catch (err) {
        await sftpCall((cb) => sftp.rename(aside, target, cb)).catch((restoreErr: Error) => {
          throw new Error(
            `${target} could not be replaced (${(err as Error).message}), and the original could not be moved back from ${aside} (${restoreErr.message})`
          )
        })
        throw err
      }
      // The new file is in place; the old one is a hidden leftover at worst.
      await sftpCall((cb) => sftp.unlink(aside, cb)).catch(() => undefined)
    } finally {
      await letGo(true)
      // Only a copy this upload made: a name that was refused is someone else's.
      if (created && !moved) {
        await sftpCall((cb) => sftp.unlink(partial, cb)).catch(() => undefined)
      }
    }
  }

  /**
   * Gives a freshly written copy the mode and owner of the file it replaces, or
   * refuses the replacement with the reason.
   *
   * Owner first, then mode: a chown clears setuid and setgid, so a 6755 binary
   * whose copy was given its mode and then its owner came out 0755. The shell
   * route has always done it in this order.
   */
  private async matchMetadata(
    sftp: SFTPWrapper,
    handle: Buffer,
    existing: Stats,
    target: string
  ): Promise<void> {
    // Through the copy's handle, not its name: see createPrivately.
    const written = await new Promise<Stats | undefined>((resolve) =>
      sftp.fstat(handle, (err, stats) => resolve(err ? undefined : stats))
    )
    if (written && (written.uid !== existing.uid || written.gid !== existing.gid)) {
      try {
        await sftpCall((cb) => sftp.fchown(handle, existing.uid, existing.gid, cb))
      } catch {
        throw new Error(
          `${target} was left unchanged: it belongs to ${existing.uid}:${existing.gid}, and this login cannot give a new copy that owner. Replacing it would change who owns it, and writing over it in place would destroy it if the transfer stopped halfway. Upload it as its owner, or remove it first.`
        )
      }
    }
    try {
      await sftpCall((cb) => sftp.fchmod(handle, existing.mode & 0o7777, cb))
    } catch (err) {
      throw new Error(
        `${target} was left unchanged: the new copy could not be given its permissions (${(err as Error).message}).`
      )
    }
  }

  /**
   * Copies one file straight from one host to another.
   *
   * The two servers usually have no route to each other, so the bytes come
   * through this process — but they never touch the disk on the way. `pipe`
   * carries the backpressure, so a 40 GB file costs a stream buffer instead of
   * 40 GB of temporary space and a directory to tidy up after the next crash.
   */
  async relay(
    srcConnectionId: string,
    srcPath: string,
    dstConnectionId: string,
    dstPath: string,
    onProgress?: (transferred: number, total: number) => void,
    /** See writeRemoteFile. */
    beforeReplace?: () => Promise<void>
  ): Promise<void> {
    const [srcSftp, dstSftp] = await Promise.all([
      this.getShell(srcConnectionId) ?? this.getSftp(srcConnectionId),
      this.getShell(dstConnectionId) ?? this.getSftp(dstConnectionId)
    ])
    // Read once up front: the progress bar needs a denominator, and the source
    // stream never reports one.
    const sourceInfo =
      srcSftp instanceof ScpShell
        ? await srcSftp.statPath(srcPath, true)
        : await this.statPath(srcConnectionId, srcPath)
    const total =
      sourceInfo?.isSymlink && !(srcSftp instanceof ScpShell)
        ? await new Promise<number>((resolve, reject) =>
            srcSftp.stat(srcPath, (err, info) => (err ? reject(err) : resolve(info.size)))
          )
        : (sourceInfo?.size ?? 0)
    const destinationMode =
      dstSftp instanceof ScpShell
        ? ((await dstSftp.statPath(dstPath, true))?.permissions ?? '0644')
        : undefined

    /*
     * One pass of the copy into `target`. A function rather than a single run,
     * because the destination may need writing twice: once under a partial name,
     * and again in place if that name could not be moved over the original.
     */
    const copyInto = (target: string, handle?: Buffer): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const read = srcSftp.createReadStream(srcPath)
        let write: Writable | null = null
        let settled = false

        // Either end can fail on its own. Whichever speaks first wins, and the
        // other is torn down rather than left holding a half-written file open.
        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          read.destroy()
          write?.destroy()
          reject(err)
        }
        read.on('error', fail)

        // The destination is not touched until the source is known to be readable.
        // Opening both at once would leave an empty file behind on the far host
        // every time a permission error stopped the read — a copy that looks like
        // it worked until someone opens the result.
        read.on('open', () => {
          write =
            dstSftp instanceof ScpShell
              ? dstSftp.createWriteStream(target, total, destinationMode)
              : handle
                ? // The copy writeRemoteFile holds open; it closes it itself.
                  dstSftp.createWriteStream(target, { handle, autoClose: false })
                : // Kept to its owner until it is in place. The default here is
                  // 0666, applied with fchmod and so past the umask: a new file
                  // relayed to a host came out writable by everyone on it.
                  dstSftp.createWriteStream(target, { mode: PARTIAL_MODE })
          write.on('error', fail)
          // 'close', not 'finish': ssh2 emits it once the remote handle is really
          // closed, and resolving earlier races whatever reads the file next.
          // A handle held open is closed by its owner, and finishing is all.
          write.on(handle ? 'finish' : 'close', () => {
            if (settled) return
            settled = true
            resolve()
          })
          // Attached here rather than earlier: a 'data' listener puts the stream
          // into flowing mode, and anything it emitted before `pipe` was attached
          // would be counted and then dropped.
          let transferred = 0
          read.on('data', (chunk: Buffer) => {
            transferred += chunk.length
            onProgress?.(transferred, total)
          })
          read.pipe(write)
        })
      })

    if (dstSftp instanceof ScpShell) await dstSftp.replace(dstPath, copyInto)
    else await this.writeRemoteFile(dstSftp, dstPath, copyInto, beforeReplace)
  }

  /**
   * Creates `dir` and every missing level above it.
   *
   * SFTP `mkdir` makes one level and fails if the parent is absent, so a
   * transfer into a destination that does not exist yet needs the whole chain
   * walked. Errors are swallowed — a directory that cannot be made will be
   * reported by the write that follows, in terms of the file it was for.
   *
   * `known` holds the directories one transfer has already found or made, so
   * a folder of a thousand files asks the server about its parent once rather
   * than a thousand times — each a round trip before the file could start.
   */
  /**
   * The first link between `root` and the folder `path` goes into, on a host.
   *
   * The far side's twin of linkBelow: `tree` in the folder chosen there could
   * be a link to anywhere, and an upload or a copy from another host wrote
   * through it with no conflict and a report of success. Folders not there
   * yet are made by the transfer, and nothing below them exists. `known`
   * remembers what one plan or one run has already looked at.
   */
  private async remoteLinkBelow(
    connectionId: string,
    root: string,
    path: string,
    known: Map<string, Promise<boolean | null>> = new Map()
  ): Promise<string | undefined> {
    const base = root.replace(/\/+$/, '') || '/'
    const parent = parentOf(path)
    if (parent === base) return undefined
    const prefix = base === '/' ? '/' : `${base}/`
    if (!parent.startsWith(prefix)) return path
    let cursor = base
    for (const part of parent.slice(prefix.length).split('/')) {
      cursor = joinRemote(cursor, part)
      // The look itself is kept, not its answer: a plan asks for many files
      // at once, and every one of them asked for the same folder before the
      // first answer came back.
      let look = known.get(cursor)
      if (!look) {
        look = this.statPath(connectionId, cursor)
          .then((info) => (info ? info.isSymlink : null))
          .catch(() => null)
        known.set(cursor, look)
      }
      const link = await look
      if (link === null) return undefined
      if (link) return cursor
    }
    return undefined
  }

  private async ensureRemoteDir(
    connectionId: string,
    dir: string,
    known: Set<string> = new Set()
  ): Promise<void> {
    if (!dir || dir === '/' || dir === '.' || known.has(dir)) return
    const existing = await this.statPath(connectionId, dir).catch(() => null)
    if (existing) {
      known.add(dir)
      return
    }
    await this.ensureRemoteDir(connectionId, parentOf(dir), known)
    const made = await this.mkdir(connectionId, dir).then(
      () => true,
      () => false
    )
    if (made) known.add(dir)
  }

  // --- Planning: what a transfer would trample, worked out before it starts ---

  /** Every file an upload of `localPath` into `remoteParent` would write. */
  private async localTree(localPath: string, remoteParent: string): Promise<TransferItem[]> {
    const info = await stat(localPath)
    const dest = `${remoteParent.replace(/\/$/, '')}/${basename(localPath)}`
    if (!info.isDirectory()) {
      return [
        {
          sourcePath: localPath,
          destPath: dest,
          sourceSize: info.size,
          sourceMtime: info.mtimeMs
        }
      ]
    }
    const out: TransferItem[] = []
    for (const entry of await readdir(localPath, { withFileTypes: true })) {
      const child = join(localPath, entry.name)
      if (entry.isDirectory()) out.push(...(await this.localTree(child, dest)))
      else if (entry.isFile()) {
        const childInfo = await stat(child)
        out.push({
          sourcePath: child,
          destPath: `${dest}/${entry.name}`,
          sourceSize: childInfo.size,
          sourceMtime: childInfo.mtimeMs
        })
      }
    }
    // Nothing below it will make it on the way to a file, so it is made itself.
    if (out.length === 0) out.push(folderItem(localPath, dest, info.mtimeMs))
    return out
  }

  /**
   * Every file reading `remotePath` into `destDir` would write.
   *
   * `joinPath` decides whose path rules the destination follows: the local
   * filesystem's for a download, POSIX for a copy to another host. Using
   * `join` for the latter would produce `\home\user\x` on Windows and hand a
   * remote server a path it cannot make sense of.
   */
  private async remoteTree(
    connectionId: string,
    remotePath: string,
    destDir: string,
    joinPath: (dir: string, name: string) => string = localChild
  ): Promise<TransferItem[]> {
    const info = await this.statPath(connectionId, remotePath)
    if (!info) return []
    // A link chosen to be fetched is fetched as what it points at; only links
    // met on the way down are left alone, below.
    const followed = info.isSymlink ? await this.targetOf(connectionId, remotePath) : undefined
    if (info.isSymlink && !followed) return []
    if (!(followed ?? info).isDirectory) {
      return [
        {
          sourcePath: remotePath,
          destPath: joinPath(destDir, info.name),
          sourceSize: (followed ?? info).size,
          sourceMtime: (followed ?? info).mtime
        }
      ]
    }
    const out: TransferItem[] = []
    for (const entry of await this.list(connectionId, remotePath)) {
      const target = joinPath(destDir, entry.name)
      // Symlinked directories are skipped here for the same reason the transfer
      // itself skips them: following one can loop or escape the tree.
      if (entry.isDirectory && !entry.isSymlink) {
        out.push(...(await this.remoteTree(connectionId, entry.path, target, joinPath)))
      } else if (entry.isSymlink) {
        /*
         * A listing describes the link, not what it points at, and every link
         * used to be planned as a file. One to a file is: its contents are
         * fetched. One to a directory is skipped like the directories above,
         * and one that leads nowhere is skipped too — fetched, either failed
         * partway through the batch.
         */
        const pointed = await this.targetOf(connectionId, entry.path)
        if (pointed && !pointed.isDirectory) {
          out.push({
            sourcePath: entry.path,
            destPath: target,
            sourceSize: pointed.size,
            sourceMtime: pointed.mtime
          })
        }
      } else if (!entry.isDirectory) {
        out.push({
          sourcePath: entry.path,
          destPath: target,
          sourceSize: entry.size,
          sourceMtime: entry.mtime
        })
      }
    }
    if (out.length === 0) out.push(folderItem(remotePath, destDir, info.mtime))
    return out
  }

  private async singleRemoteItem(
    connectionId: string,
    remotePath: string,
    destPath: string
  ): Promise<TransferItem[]> {
    const info = await this.statPath(connectionId, remotePath)
    if (!info) return []
    return [{ sourcePath: remotePath, destPath, sourceSize: info.size, sourceMtime: info.mtime }]
  }

  async planUpload(
    connectionId: string,
    localPath: string,
    remoteParent: string
  ): Promise<TransferPlan> {
    const items = await this.localTree(localPath, remoteParent)
    const found = new Map<string, DestInfo | null>()
    const unique = [...new Map(items.map((item) => [item.destPath, item])).values()]
    const known = new Map<string, Promise<boolean | null>>()
    await forEachConcurrent(unique, async (item) => {
      // Reached through a link below the chosen folder: refused, as a link is.
      if (await this.remoteLinkBelow(connectionId, remoteParent, item.destPath, known)) {
        found.set(item.destPath, { size: 0, mtime: 0, isDirectory: false, isSymlink: true })
        return
      }
      try {
        const info = await this.statPath(connectionId, item.destPath)
        found.set(
          item.destPath,
          info
            ? {
                size: info.size,
                mtime: info.mtime,
                isDirectory: info.isDirectory,
                isSymlink: info.isSymlink
              }
            : null
        )
      } catch {
        // Could not be stated at all — treated as occupied, never as empty.
        found.set(item.destPath, {
          size: 0,
          mtime: 0,
          isDirectory: false,
          isSymlink: false,
          unreadable: true
        })
      }
    })
    return {
      ...buildTransferPlan('upload', items, (p) => found.get(p) ?? null),
      remoteRoot: remoteParent
    }
  }

  /**
   * `localTarget` is the folder the item lands in — a remote folder as a folder
   * of its own name inside it, the rule uploads and relays follow — or, with
   * `exactFile`, the precise filename the user chose in the save dialog. Saving
   * one file under a new name must be checked against that name, not against
   * the original.
   *
   * The folder's own name is joined here, through `localChild`, and not by the
   * window. The window used to join it with a slash, and a remote folder name
   * is the server's to choose: on a Unix host `..\..\Startup` is one ordinary
   * name, and on Windows it walked the whole download out of the folder that
   * had been picked for it. Every name below it was already checked; the top
   * one was not.
   */
  async planDownload(
    connectionId: string,
    remotePath: string,
    localTarget: string,
    exactFile = false
  ): Promise<TransferPlan> {
    const root = exactFile ? undefined : await this.statPath(connectionId, remotePath)
    // A chosen link to a directory lands under its own name, as a directory does.
    const rootIsDirectory =
      root?.isDirectory ||
      (root?.isSymlink && (await this.targetOf(connectionId, remotePath))?.isDirectory)
    const items = exactFile
      ? await this.singleRemoteItem(connectionId, remotePath, localTarget)
      : rootIsDirectory && root
        ? await this.remoteTree(connectionId, remotePath, localChild(localTarget, root.name))
        : await this.remoteTree(connectionId, remotePath, localTarget)
    const localRoot = exactFile ? undefined : localTarget
    const found = new Map<string, DestInfo | null>()
    const unique = [...new Map(items.map((item) => [item.destPath, item])).values()]
    await forEachConcurrent(unique, async (item) => {
      // Reached through a link below the chosen folder: refused, as a link is.
      if (localRoot && (await linkBelow(localRoot, item.destPath))) {
        found.set(item.destPath, { size: 0, mtime: 0, isDirectory: false, isSymlink: true })
        return
      }
      try {
        const info = await lstat(item.destPath)
        found.set(item.destPath, {
          size: info.size,
          mtime: info.mtimeMs,
          isDirectory: info.isDirectory(),
          isSymlink: info.isSymbolicLink()
        })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        found.set(
          item.destPath,
          code === 'ENOENT'
            ? null
            : { size: 0, mtime: 0, isDirectory: false, isSymlink: false, unreadable: true }
        )
      }
    })
    const plan = buildTransferPlan('download', items, (p) => found.get(p) ?? null)
    return localRoot ? { ...plan, localRoot } : plan
  }

  /**
   * Every file a copy of `remotePath` into `destParent` on another host would
   * write, checked against what is already sitting there.
   *
   * A directory is copied as itself — into `destParent/<name>` — while a single
   * file lands in `destParent` directly, which is the same rule the upload and
   * download planners follow.
   */
  async planRelay(
    srcConnectionId: string,
    srcPath: string,
    dstConnectionId: string,
    destParent: string
  ): Promise<TransferPlan> {
    const source = await this.statPath(srcConnectionId, srcPath)
    // A chosen link to a directory is copied as that directory, under the
    // link's name — as a download places it. See remoteTree.
    const sourceIsDirectory =
      source?.isDirectory ||
      (source?.isSymlink && (await this.targetOf(srcConnectionId, srcPath))?.isDirectory)
    const destDir = sourceIsDirectory ? joinRemote(destParent, baseNameOf(srcPath)) : destParent
    // Each name from the source's listing taken as one plain segment, as a
    // download takes it with localChild.
    const items = await this.remoteTree(srcConnectionId, srcPath, destDir, remoteChild)

    const found = new Map<string, DestInfo | null>()
    const unique = [...new Map(items.map((item) => [item.destPath, item])).values()]
    const known = new Map<string, Promise<boolean | null>>()
    await forEachConcurrent(unique, async (item) => {
      if (await this.remoteLinkBelow(dstConnectionId, destParent, item.destPath, known)) {
        found.set(item.destPath, { size: 0, mtime: 0, isDirectory: false, isSymlink: true })
        return
      }
      try {
        const info = await this.statPath(dstConnectionId, item.destPath)
        found.set(
          item.destPath,
          info
            ? {
                size: info.size,
                mtime: info.mtime,
                isDirectory: info.isDirectory,
                isSymlink: info.isSymlink
              }
            : null
        )
      } catch {
        // Could not be stated at all — treated as occupied, never as empty.
        found.set(item.destPath, {
          size: 0,
          mtime: 0,
          isDirectory: false,
          isSymlink: false,
          unreadable: true
        })
      }
    })
    return {
      ...buildTransferPlan('relay', items, (p) => found.get(p) ?? null),
      remoteRoot: destParent
    }
  }

  /**
   * Runs a planned transfer, honouring the answers collected for it.
   *
   * `destConnectionId` is the far end of a relay, and is ignored by the other
   * two directions — for those, `connectionId` is the only host involved.
   */
  async runPlan(
    connectionId: string,
    plan: TransferPlan,
    decisions: TransferDecisions = NO_DECISIONS,
    onProgress?: ProgressFn,
    destConnectionId?: string
  ): Promise<TransferResult> {
    if (plan.direction === 'relay' && !destConnectionId) {
      throw new Error('A host-to-host copy needs a destination connection')
    }
    let written = 0
    let skipped = 0
    const changed: string[] = []
    /* What the plan found already occupied. A conflict with no answer is left
       alone rather than overwritten; see shouldWrite. */
    const conflicted = conflictedPaths(plan)
    const askedAbout = new Map(plan.conflicts.map((c) => [c.destPath, c]))
    /** Remote directories this transfer has found or made; see ensureRemoteDir. */
    const madeDirs = new Set<string>()
    /** Remote folders this run has looked at for links; see remoteLinkBelow. */
    const remoteFolders = new Map<string, Promise<boolean | null>>()
    for (const item of plan.items) {
      if (!shouldWrite(item.destPath, decisions, conflicted)) {
        skipped++
        continue
      }
      /*
       * Looked at again, immediately before writing.
       *
       * The plan is a picture of the destination taken before anybody answered
       * the dialog, and a transfer of many files takes a while after that. A
       * file that was not there when the plan was made — and so was never asked
       * about — could be there by the time its turn came, and was overwritten
       * without a question ever having been put. What changed since the plan is
       * left alone and reported, and the rest of the batch goes on.
       */
      const now = await this.destinationNow(
        plan.direction,
        plan.direction === 'relay' ? destConnectionId! : connectionId,
        item.destPath
      )
      if (
        !stillAsPlanned(
          conflicted.has(item.destPath),
          now,
          item.isDirectory,
          askedAbout.get(item.destPath)
        )
      ) {
        skipped++
        changed.push(item.destPath)
        continue
      }
      // Looked for again: a link can be put there after the plan was made. An
      // empty folder is made here and now, so it is looked for before that too.
      if (
        plan.direction === 'download' &&
        plan.localRoot &&
        (await linkBelow(plan.localRoot, item.destPath))
      ) {
        skipped++
        changed.push(item.destPath)
        continue
      }
      // The same on the far side, once per folder for the run.
      if (
        plan.direction !== 'download' &&
        plan.remoteRoot &&
        (await this.remoteLinkBelow(
          plan.direction === 'relay' ? destConnectionId! : connectionId,
          plan.remoteRoot,
          item.destPath,
          remoteFolders
        ))
      ) {
        skipped++
        changed.push(item.destPath)
        continue
      }
      if (item.isDirectory) {
        if (plan.direction === 'download') await mkdir(item.destPath, { recursive: true })
        else {
          const host = plan.direction === 'relay' ? destConnectionId! : connectionId
          await this.ensureRemoteDir(host, item.destPath, madeDirs)
          // ensureRemoteDir swallows its errors for the file that follows; here
          // there is no file to report one, so the folder is checked for.
          if (!(await this.statPath(host, item.destPath))?.isDirectory) {
            throw new Error(`Could not create the folder ${item.destPath}`)
          }
        }
        written++
        continue
      }
      let totalBytes = item.sourceSize
      const report = (transferred: number, total: number): void => {
        totalBytes = total
        onProgress?.(transferred, total, item.sourcePath)
      }
      if (plan.direction !== 'download') {
        const host = plan.direction === 'relay' ? destConnectionId! : connectionId
        // The file asked about, looked at once more as the copy is about to replace it.
        const beforeReplace = async (): Promise<void> => {
          const found = await this.destinationNow(plan.direction, host, item.destPath)
          if (
            !stillAsPlanned(
              conflicted.has(item.destPath),
              found,
              false,
              askedAbout.get(item.destPath)
            )
          ) {
            throw new DestinationChanged(item.destPath)
          }
        }
        await this.ensureRemoteDir(host, parentOf(item.destPath), madeDirs)
        try {
          if (plan.direction === 'relay') {
            await this.relay(
              connectionId,
              item.sourcePath,
              host,
              item.destPath,
              report,
              beforeReplace
            )
          } else {
            await this.upload(connectionId, item.sourcePath, item.destPath, report, beforeReplace)
          }
        } catch (err) {
          if (!(err instanceof DestinationChanged)) throw err
          skipped++
          changed.push(item.destPath)
          continue
        }
      } else {
        // dirname, not a hand-rolled search for the last '/'. This is a local
        // path, and on Windows it holds no forward slash at all: the search
        // returned -1, slice(0, -1) chopped the last character off the file
        // name, and every download quietly created a directory beside itself
        // called C:\...\a.tx. It went unnoticed because that same call, being
        // recursive, made the real parent on the way past.
        await mkdir(dirname(item.destPath), { recursive: true })
        try {
          // Replaced only where the plan found a file and was told to overwrite
          // it; anything else is kept, and reported like any other change.
          await this.download(
            connectionId,
            item.sourcePath,
            item.destPath,
            report,
            conflicted.has(item.destPath),
            askedAbout.get(item.destPath),
            plan.localRoot
          )
        } catch (err) {
          if (!(err instanceof DestinationAppeared)) throw err
          skipped++
          changed.push(item.destPath)
          continue
        }
      }
      report(totalBytes, totalBytes)
      written++
    }
    return { written, skipped, changed }
  }

  /** What sits at a destination right now, looked up the way planning looks it up. */
  private async destinationNow(
    direction: TransferPlan['direction'],
    connectionId: string,
    destPath: string
  ): Promise<DestInfo | null> {
    try {
      if (direction === 'download') {
        const info = await lstat(destPath)
        return {
          size: info.size,
          mtime: info.mtimeMs,
          isDirectory: info.isDirectory(),
          isSymlink: info.isSymbolicLink()
        }
      }
      const info = await this.statPath(connectionId, destPath)
      return info
        ? {
            size: info.size,
            mtime: info.mtime,
            isDirectory: info.isDirectory,
            isSymlink: info.isSymlink
          }
        : null
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { size: 0, mtime: 0, isDirectory: false, isSymlink: false, unreadable: true }
    }
  }

  /** Reads a remote file into memory, refusing anything past the diff cap. */
  private async readRemote(connectionId: string, remotePath: string): Promise<Buffer> {
    const sftp = this.getShell(connectionId) ?? (await this.getSftp(connectionId))
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      const stream = sftp.createReadStream(remotePath)
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_DIFF_BYTES) {
          stream.destroy()
          reject(new Error('File is larger than the comparison limit'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('close', () => {
        if (!stream.readableEnded)
          reject(new Error('The remote file closed before comparison completed'))
      })
    })
  }

  /**
   * Both sides of a file, ready to diff — or a reason there is nothing to show.
   * The guards are here rather than in the dialog so that an oversized or
   * binary file is never read across the wire in the first place.
   */
  async compareWithLocal(
    connectionId: string,
    remotePath: string,
    localPath: string
  ): Promise<FileComparison> {
    const remoteInfo = await this.statPath(connectionId, remotePath)
    const localInfo = await stat(localPath).catch(() => null)
    const base: FileComparison = {
      remotePath,
      localPath,
      remote: null,
      local: null,
      remoteSize: remoteInfo?.size ?? 0,
      localSize: localInfo?.size ?? 0
    }
    if (!remoteInfo || !localInfo) return { ...base, blocked: 'missing' }
    if (remoteInfo.size > MAX_DIFF_BYTES || localInfo.size > MAX_DIFF_BYTES) {
      return { ...base, blocked: 'too-large' }
    }

    const [remoteBuf, localBuf] = await Promise.all([
      this.readRemote(connectionId, remotePath),
      readFile(localPath)
    ])
    if (looksBinary(remoteBuf) || looksBinary(localBuf)) return { ...base, blocked: 'binary' }

    return { ...base, remote: remoteBuf.toString('utf8'), local: localBuf.toString('utf8') }
  }

  releaseConnection(connectionId: string): void {
    this.opening.delete(connectionId)
    this.shells.get(connectionId)?.close()
    this.shells.delete(connectionId)
    this.sessions.delete(connectionId)
  }
}

export const sftpManager = new SFTPManager()
