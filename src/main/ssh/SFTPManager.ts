import { forEachConcurrent } from './parallel'
import { ScpShell } from './ScpShell'
import type { Writable } from 'stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import { readdir, mkdir, stat, lstat, readFile } from 'fs/promises'
import { renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import { sshManager } from './SSHManager'
import { localChild } from '../localName'
import {
  buildTransferPlan,
  conflictedPaths,
  shouldWrite,
  type DestInfo
} from '../../shared/transferPlan'
import { baseNameOf, joinRemote, parentOf } from '../../shared/remotePath'
import { parseLongnameOwner } from '../../shared/permissions'
import type {
  FileComparison,
  SftpEntry,
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
 */
export function partialNameFor(path: string, n: number): string {
  return joinRemote(parentOf(path), `.${baseNameOf(path)}.td-partial-${process.pid}-${n}`)
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
  folder = false
): boolean {
  if (!now) return true
  if (folder) return now.isDirectory && !now.unreadable
  if (!wasOccupied) return false
  return !now.isDirectory && !now.isSymlink && !now.unreadable
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
    onProgress?: (transferred: number, total: number) => void
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
     */
    const partial = `${localPath}.part-${process.pid}-${this.nextTransfer++}`
    try {
      if (shell) await shell.download(remotePath, partial, onProgress)
      else
        await new Promise<void>((resolve, reject) => {
          sftp!.fastGet(
            remotePath,
            partial,
            { step: (transferred, _chunk, total) => onProgress?.(transferred, total) },
            (err) => (err ? reject(err) : resolve())
          )
        })
      renameSync(partial, localPath)
    } catch (err) {
      // Nothing half-finished is left lying beside the file it failed to become.
      try {
        rmSync(partial, { force: true })
      } catch {
        // Already gone, or never created.
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
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const shell = this.getShell(connectionId)
    if (shell) return shell.upload(localPath, remotePath, onProgress)
    const sftp = await this.getSftp(connectionId)
    await this.writeRemoteFile(
      sftp,
      remotePath,
      (target) =>
        new Promise<void>((resolve, reject) => {
          sftp.fastPut(
            localPath,
            target,
            { step: (transferred, _chunk, total) => onProgress?.(transferred, total) },
            (err) => (err ? reject(err) : resolve())
          )
        })
    )
  }

  /**
   * Writes a remote file so that a transfer which stops halfway leaves the file
   * that was there, not the first half of the new one.
   *
   * Uploads used to go straight into place. A dropped link then left a
   * truncated file where a whole one had been — for a configuration file, a
   * broken service — and nothing on either side said so.
   *
   * So the bytes go to a hidden name beside the destination and are moved onto
   * it at the end. Two things held this back before, and both are dealt with
   * rather than accepted:
   *
   * - The new file is created by this login, so it carries this login's owner
   *   and default mode. The mode is copied across from the file being replaced,
   *   and so is the owner where the server permits it. Where it does not, the
   *   file is written in place as it always was — changing who owns a server's
   *   configuration is a larger accident than a transfer that fails partway.
   * - SSH_FXP_RENAME refuses an existing destination on most servers. Replacing
   *   one needs OpenSSH's `posix-rename`, which is nearly everywhere; where it is
   *   missing, the same in-place write is the fallback.
   *
   * A destination that did not exist is simply renamed into place, and if
   * something appeared there in the meantime the rename refuses and that
   * something is left alone. A symlink is written through, as before: renaming
   * over it would replace the link with a file.
   */
  private async writeRemoteFile(
    sftp: SFTPWrapper,
    remotePath: string,
    write: (target: string) => Promise<void>
  ): Promise<void> {
    const existing = await lstatRaw(sftp, remotePath)
    if (existing?.isDirectory())
      throw new Error(`Refusing to write over the directory ${remotePath}`)
    if (existing?.isSymbolicLink()) return write(remotePath)

    const partial = partialNameFor(remotePath, this.nextTransfer++)
    let moved = false
    let inPlace = false
    try {
      await write(partial)
      if (!existing) {
        await sftpCall((cb) => sftp.rename(partial, remotePath, cb)).catch((err: Error) => {
          throw new Error(
            `${remotePath} could not be put in place (${err.message}). If something appeared there during the transfer, it was left alone.`
          )
        })
        moved = true
        return
      }
      inPlace = !(await this.takeOver(sftp, partial, existing))
      if (!inPlace) {
        await sftpCall((cb) => sftp.ext_openssh_rename(partial, remotePath, cb))
        moved = true
      }
    } finally {
      if (!moved) await sftpCall((cb) => sftp.unlink(partial, cb)).catch(() => undefined)
    }
    if (inPlace) await write(remotePath)
  }

  /**
   * Makes a freshly written file look like the one it will replace — mode and
   * owner — and says whether it can replace it by rename at all.
   */
  private async takeOver(sftp: SFTPWrapper, partial: string, existing: Stats): Promise<boolean> {
    if (!supportsPosixRename(sftp)) return false
    try {
      await sftpCall((cb) => sftp.chmod(partial, existing.mode & 0o7777, cb))
      const written = await lstatRaw(sftp, partial)
      if (!written) return false
      if (written.uid !== existing.uid || written.gid !== existing.gid) {
        await sftpCall((cb) => sftp.chown(partial, existing.uid, existing.gid, cb))
      }
      return true
    } catch {
      return false
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
    onProgress?: (transferred: number, total: number) => void
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
    const copyInto = (target: string): Promise<void> =>
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
              : dstSftp.createWriteStream(target)
          write.on('error', fail)
          // 'close', not 'finish': ssh2 emits it once the remote handle is really
          // closed, and resolving earlier races whatever reads the file next.
          write.on('close', () => {
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
    else await this.writeRemoteFile(dstSftp, dstPath, copyInto)
  }

  /**
   * Creates `dir` and every missing level above it.
   *
   * SFTP `mkdir` makes one level and fails if the parent is absent, so a
   * transfer into a destination that does not exist yet needs the whole chain
   * walked. Errors are swallowed — a directory that cannot be made will be
   * reported by the write that follows, in terms of the file it was for.
   */
  private async ensureRemoteDir(connectionId: string, dir: string): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return
    const existing = await this.statPath(connectionId, dir).catch(() => null)
    if (existing) return
    await this.ensureRemoteDir(connectionId, parentOf(dir))
    await this.mkdir(connectionId, dir).catch(() => undefined)
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
    if (!info.isDirectory) {
      return [
        {
          sourcePath: remotePath,
          destPath: joinPath(destDir, info.name),
          sourceSize: info.size,
          sourceMtime: info.mtime
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
    await forEachConcurrent(unique, async (item) => {
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
    return buildTransferPlan('upload', items, (p) => found.get(p) ?? null)
  }

  /**
   * `localTarget` is a directory to mirror into, or — with `exactFile` — the
   * precise filename the user chose in the save dialog. Saving one file under a
   * new name must be checked against that name, not against the original.
   */
  async planDownload(
    connectionId: string,
    remotePath: string,
    localTarget: string,
    exactFile = false
  ): Promise<TransferPlan> {
    const items = exactFile
      ? await this.singleRemoteItem(connectionId, remotePath, localTarget)
      : await this.remoteTree(connectionId, remotePath, localTarget)
    const found = new Map<string, DestInfo | null>()
    const unique = [...new Map(items.map((item) => [item.destPath, item])).values()]
    await forEachConcurrent(unique, async (item) => {
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
    return buildTransferPlan('download', items, (p) => found.get(p) ?? null)
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
    const destDir = source?.isDirectory ? joinRemote(destParent, baseNameOf(srcPath)) : destParent
    const items = await this.remoteTree(srcConnectionId, srcPath, destDir, joinRemote)

    const found = new Map<string, DestInfo | null>()
    const unique = [...new Map(items.map((item) => [item.destPath, item])).values()]
    await forEachConcurrent(unique, async (item) => {
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
    return buildTransferPlan('relay', items, (p) => found.get(p) ?? null)
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
      if (!stillAsPlanned(conflicted.has(item.destPath), now, item.isDirectory)) {
        skipped++
        changed.push(item.destPath)
        continue
      }
      if (item.isDirectory) {
        if (plan.direction === 'download') await mkdir(item.destPath, { recursive: true })
        else {
          const host = plan.direction === 'relay' ? destConnectionId! : connectionId
          await this.ensureRemoteDir(host, item.destPath)
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
      if (plan.direction === 'relay') {
        await this.ensureRemoteDir(destConnectionId!, parentOf(item.destPath))
        await this.relay(connectionId, item.sourcePath, destConnectionId!, item.destPath, report)
      } else if (plan.direction === 'upload') {
        await this.ensureRemoteDir(connectionId, parentOf(item.destPath))
        await this.upload(connectionId, item.sourcePath, item.destPath, report)
      } else {
        // dirname, not a hand-rolled search for the last '/'. This is a local
        // path, and on Windows it holds no forward slash at all: the search
        // returned -1, slice(0, -1) chopped the last character off the file
        // name, and every download quietly created a directory beside itself
        // called C:\...\a.tx. It went unnoticed because that same call, being
        // recursive, made the real parent on the way past.
        await mkdir(dirname(item.destPath), { recursive: true })
        await this.download(connectionId, item.sourcePath, item.destPath, report)
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
      stream.on('close', () => resolve(Buffer.concat(chunks)))
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
