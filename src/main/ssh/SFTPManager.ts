import type { SFTPWrapper } from 'ssh2'
import { readdir, mkdir, stat, lstat, readFile } from 'fs/promises'
import { join, basename } from 'path'
import { sshManager } from './SSHManager'
import { buildTransferPlan, shouldWrite, type DestInfo } from '../../shared/transferPlan'
import { parseLongnameOwner } from '../../shared/permissions'
import type {
  FileComparison,
  SftpEntry,
  TransferDecisions,
  TransferItem,
  TransferPlan
} from '../../shared/types'

type ProgressFn = (transferred: number, total: number, path: string) => void

const NO_DECISIONS: TransferDecisions = {}

/**
 * Past this, a file is not diffed. Reading a 200 MB log into the renderer to
 * compare it line by line would lock the window for an answer nobody wants in
 * that form.
 */
const MAX_DIFF_BYTES = 2 * 1024 * 1024

/** Text or not: the same test `grep` and `git` use — a NUL byte early on. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

class SFTPManager {
  private sessions = new Map<string, SFTPWrapper>()

  private async getSftp(connectionId: string): Promise<SFTPWrapper> {
    const cached = this.sessions.get(connectionId)
    if (cached) return cached

    const chain = sshManager.getClientChain(connectionId)
    if (!chain || chain.length === 0) throw new Error('No active SSH connection')
    const target = chain[chain.length - 1]

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      target.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
    this.sessions.set(connectionId, sftp)
    return sftp
  }

  async list(connectionId: string, remotePath: string): Promise<SftpEntry[]> {
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
    const sftp = await this.getSftp(connectionId)
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath, (err, resolved) => (err ? reject(err) : resolve(resolved)))
    })
  }

  /** A stat that answers "missing" rather than throwing, for existence checks. */
  async statPath(connectionId: string, remotePath: string): Promise<SftpEntry | null> {
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
    const sftp = await this.getSftp(connectionId)
    if (isDirectory) {
      for (const entry of await this.list(connectionId, remotePath)) {
        await this.delete(connectionId, entry.path, entry.isDirectory && !entry.isSymlink)
      }
    }
    await new Promise<void>((resolve, reject) => {
      const cb = (err: Error | undefined | null): void => (err ? reject(err) : resolve())
      if (isDirectory) sftp.rmdir(remotePath, cb)
      else sftp.unlink(remotePath, cb)
    })
  }

  async rename(connectionId: string, oldPath: string, newPath: string): Promise<void> {
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
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        { step: (transferred, _chunk, total) => onProgress?.(transferred, total) },
        (err) => (err ? reject(err) : resolve())
      )
    })
  }

  async upload(
    connectionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<void> {
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        { step: (transferred, _chunk, total) => onProgress?.(transferred, total) },
        (err) => (err ? reject(err) : resolve())
      )
    })
  }

  /** Mirrors a remote directory into `localDir`, creating it if needed. */
  async downloadDirectory(
    connectionId: string,
    remotePath: string,
    localDir: string,
    onProgress?: ProgressFn
  ): Promise<void> {
    await mkdir(localDir, { recursive: true })
    for (const entry of await this.list(connectionId, remotePath)) {
      const target = join(localDir, entry.name)
      // Symlinked directories are skipped: following them can loop forever and
      // pull in files from outside the tree.
      if (entry.isDirectory && !entry.isSymlink) {
        await this.downloadDirectory(connectionId, entry.path, target, onProgress)
      } else if (!entry.isDirectory) {
        await this.download(connectionId, entry.path, target, (t, total) =>
          onProgress?.(t, total, entry.path)
        )
      }
    }
  }

  /** Mirrors a local directory into `remoteParent/<dirname>`. */
  async uploadDirectory(
    connectionId: string,
    localPath: string,
    remoteParent: string,
    onProgress?: ProgressFn
  ): Promise<void> {
    const remoteDir = `${remoteParent.replace(/\/$/, '')}/${basename(localPath)}`
    try {
      await this.mkdir(connectionId, remoteDir)
    } catch {
      // Already there — carry on and merge into it.
    }
    for (const entry of await readdir(localPath, { withFileTypes: true })) {
      const child = join(localPath, entry.name)
      if (entry.isDirectory()) {
        await this.uploadDirectory(connectionId, child, remoteDir, onProgress)
      } else if (entry.isFile()) {
        await this.upload(connectionId, child, `${remoteDir}/${entry.name}`, (t, total) =>
          onProgress?.(t, total, child)
        )
      }
    }
  }

  /** Uploads a path of either kind, so callers don't have to stat it themselves. */
  async uploadPath(
    connectionId: string,
    localPath: string,
    remoteParent: string,
    onProgress?: ProgressFn
  ): Promise<void> {
    const info = await stat(localPath)
    if (info.isDirectory()) {
      await this.uploadDirectory(connectionId, localPath, remoteParent, onProgress)
    } else {
      const remote = `${remoteParent.replace(/\/$/, '')}/${basename(localPath)}`
      await this.upload(connectionId, localPath, remote, (t, total) =>
        onProgress?.(t, total, localPath)
      )
    }
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
    return out
  }

  /** Every file a download of `remotePath` into `localDir` would write. */
  private async remoteTree(
    connectionId: string,
    remotePath: string,
    localDir: string
  ): Promise<TransferItem[]> {
    const info = await this.statPath(connectionId, remotePath)
    if (!info) return []
    if (!info.isDirectory) {
      return [
        {
          sourcePath: remotePath,
          destPath: join(localDir, info.name),
          sourceSize: info.size,
          sourceMtime: info.mtime
        }
      ]
    }
    const out: TransferItem[] = []
    for (const entry of await this.list(connectionId, remotePath)) {
      const target = join(localDir, entry.name)
      // Symlinked directories are skipped here for the same reason the transfer
      // itself skips them: following one can loop or escape the tree.
      if (entry.isDirectory && !entry.isSymlink) {
        out.push(...(await this.remoteTree(connectionId, entry.path, target)))
      } else if (!entry.isDirectory) {
        out.push({
          sourcePath: entry.path,
          destPath: target,
          sourceSize: entry.size,
          sourceMtime: entry.mtime
        })
      }
    }
    return out
  }

  private async singleRemoteItem(
    connectionId: string,
    remotePath: string,
    destPath: string
  ): Promise<TransferItem[]> {
    const info = await this.statPath(connectionId, remotePath)
    if (!info) return []
    return [
      { sourcePath: remotePath, destPath, sourceSize: info.size, sourceMtime: info.mtime }
    ]
  }

  async planUpload(
    connectionId: string,
    localPath: string,
    remoteParent: string
  ): Promise<TransferPlan> {
    const items = await this.localTree(localPath, remoteParent)
    const found = new Map<string, DestInfo | null>()
    for (const item of items) {
      if (found.has(item.destPath)) continue
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
    }
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
    for (const item of items) {
      if (found.has(item.destPath)) continue
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
    }
    return buildTransferPlan('download', items, (p) => found.get(p) ?? null)
  }

  /** Runs a planned transfer, honouring the answers collected for it. */
  async runPlan(
    connectionId: string,
    plan: TransferPlan,
    decisions: TransferDecisions = NO_DECISIONS,
    onProgress?: ProgressFn
  ): Promise<{ written: number; skipped: number }> {
    let written = 0
    let skipped = 0
    for (const item of plan.items) {
      if (!shouldWrite(item.destPath, decisions)) {
        skipped++
        continue
      }
      if (plan.direction === 'upload') {
        const parent = item.destPath.slice(0, item.destPath.lastIndexOf('/'))
        if (parent) await this.mkdir(connectionId, parent).catch(() => undefined)
        await this.upload(connectionId, item.sourcePath, item.destPath, (t, total) =>
          onProgress?.(t, total, item.sourcePath)
        )
      } else {
        await mkdir(item.destPath.slice(0, item.destPath.lastIndexOf('/')) || '/', {
          recursive: true
        })
        await this.download(connectionId, item.sourcePath, item.destPath, (t, total) =>
          onProgress?.(t, total, item.sourcePath)
        )
      }
      written++
    }
    return { written, skipped }
  }

  /** Reads a remote file into memory, refusing anything past the diff cap. */
  private async readRemote(connectionId: string, remotePath: string): Promise<Buffer> {
    const sftp = await this.getSftp(connectionId)
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
    this.sessions.delete(connectionId)
  }
}

export const sftpManager = new SFTPManager()
