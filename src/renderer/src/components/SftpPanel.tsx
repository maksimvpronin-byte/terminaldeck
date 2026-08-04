import { useEffect, useState } from 'react'
import type { SftpEntry } from '../../../shared/types'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}

interface Transfer {
  path: string
  transferred: number
  total: number
}

export default function SftpPanel({ connectionId }: { connectionId?: string }): JSX.Element {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)

  useEffect(() => {
    if (!connectionId) return
    const off = window.td.sftp.onProgress(connectionId, (p) => {
      setTransfer(p.transferred >= p.total ? null : p)
    })
    return off
  }, [connectionId])

  async function load(p: string): Promise<void> {
    if (!connectionId) return
    try {
      const list = await window.td.sftp.list(connectionId, p)
      setEntries(list.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)))
      setPath(p)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    if (connectionId) load('.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  async function download(entry: SftpEntry): Promise<void> {
    const localPath = await window.td.dialogs.pickSavePath(entry.name)
    if (!localPath || !connectionId) return
    await window.td.sftp.download(connectionId, entry.path, localPath)
  }

  async function upload(): Promise<void> {
    const localPath = await window.td.dialogs.pickOpenPath()
    if (!localPath || !connectionId) return
    const name = localPath.split(/[/\\]/).pop() ?? 'file'
    await window.td.sftp.upload(connectionId, localPath, `${path.replace(/\/$/, '')}/${name}`)
    load(path)
  }

  return (
    <div className="sftp-panel">
      <div className="sftp-path">{path}</div>
      <div className="sftp-list">
        {path !== '.' && path !== '/' && (
          <div className="sftp-row" onClick={() => load(path.split('/').slice(0, -1).join('/') || '/')}>
            <span className="name">..</span>
          </div>
        )}
        {entries.map((e) => (
          <div
            key={e.path}
            className="sftp-row"
            onClick={() => (e.isDirectory ? load(e.path) : download(e))}
            title={e.isDirectory ? 'Open folder' : 'Click to download'}
          >
            <span className="name">
              {e.isDirectory ? '📁' : '📄'} {e.name}
            </span>
            {!e.isDirectory && <span className="size">{formatSize(e.size)}</span>}
          </div>
        ))}
      </div>
      {error && <div className="error-text" style={{ padding: 6 }}>{error}</div>}
      {transfer && (
        <div className="sftp-progress">
          <div className="sftp-progress-label">
            {transfer.path.split('/').pop()} — {formatSize(transfer.transferred)} /{' '}
            {formatSize(transfer.total)}
          </div>
          <div className="sftp-progress-track">
            <div
              className="sftp-progress-bar"
              style={{
                width: `${transfer.total > 0 ? (transfer.transferred / transfer.total) * 100 : 0}%`
              }}
            />
          </div>
        </div>
      )}
      <div style={{ padding: 6, borderTop: '1px solid var(--border)' }}>
        <button onClick={upload} style={{ width: '100%' }}>
          Upload file…
        </button>
      </div>
    </div>
  )
}
