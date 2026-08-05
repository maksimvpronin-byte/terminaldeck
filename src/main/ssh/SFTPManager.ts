import type { SFTPWrapper } from 'ssh2'
import { readdir, mkdir, stat } from 'fs/promises'
import { join, basename } from 'path'
import { sshManager } from './SSHManager'
import type { SftpEntry } from '../../shared/types'

type ProgressFn = (transferred: number, total: number, path: string) => void

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
    return entries.map((e) => ({
      name: e.filename,
      path: remotePath.replace(/\/$/, '') + '/' + e.filename,
      isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
      isSymlink: (e.attrs.mode & 0o170000) === 0o120000,
      size: e.attrs.size ?? 0,
      mtime: (e.attrs.mtime ?? 0) * 1000,
      permissions: (e.attrs.mode & 0o777).toString(8)
    }))
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

  releaseConnection(connectionId: string): void {
    this.sessions.delete(connectionId)
  }
}

export const sftpManager = new SFTPManager()
