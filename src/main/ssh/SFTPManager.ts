import type { SFTPWrapper } from 'ssh2'
import { sshManager } from './SSHManager'
import type { SftpEntry } from '../../shared/types'

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

  async delete(connectionId: string, remotePath: string, isDirectory: boolean): Promise<void> {
    const sftp = await this.getSftp(connectionId)
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

  async download(connectionId: string, remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve()))
    })
  }

  async upload(connectionId: string, localPath: string, remotePath: string): Promise<void> {
    const sftp = await this.getSftp(connectionId)
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve()))
    })
  }

  releaseConnection(connectionId: string): void {
    this.sessions.delete(connectionId)
  }
}

export const sftpManager = new SFTPManager()
