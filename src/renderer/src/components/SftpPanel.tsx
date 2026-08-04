import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { SftpEntry } from '../../../shared/types'
import ModalBackdrop from './ModalBackdrop'
import ContextMenu, { type MenuItem } from './ContextMenu'

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

interface MenuState {
  x: number
  y: number
  /** Empty when the click landed on blank space rather than a row. */
  entries: SftpEntry[]
}

export default function SftpPanel({ connectionId }: { connectionId?: string }): JSX.Element {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [dragging, setDragging] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<{ entry: SftpEntry; value: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SftpEntry[] | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const lastClickedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!connectionId) return
    const off = window.td.sftp.onProgress(connectionId, (p) => {
      setTransfer(p.transferred >= p.total ? null : p)
    })
    return off
  }, [connectionId])

  async function fetchList(p: string, silent: boolean): Promise<SftpEntry[] | null> {
    if (!connectionId) return null
    try {
      const list = await window.td.sftp.list(connectionId, p)
      list.sort(
        (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
      )
      setEntries(list)
      setError(null)
      return list
    } catch (err) {
      // A silent poll must not spam the panel with errors on a transient failure.
      if (!silent) setError((err as Error).message)
      return null
    }
  }

  /** Navigate to a directory. */
  async function load(p: string): Promise<void> {
    setPath(p)
    setSelected(new Set())
    await fetchList(p, false)
  }

  /** Re-read the current directory, keeping the selection that still exists. */
  async function refresh(silent = false): Promise<void> {
    const list = await fetchList(path, silent)
    if (!list) return
    setSelected((prev) => {
      const alive = new Set(list.map((e) => e.path))
      return new Set([...prev].filter((p) => alive.has(p)))
    })
  }

  useEffect(() => {
    if (connectionId) load('.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  // Poll so changes made in the terminal (rm, mv, mkdir) show up on their own.
  // Paused while the user is mid-action or a transfer is running.
  useEffect(() => {
    if (!connectionId) return
    const busy = transfer !== null || renaming !== null || newFolder !== null || menu !== null
    if (busy) return
    const id = setInterval(() => refresh(true), 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, path, transfer, renaming, newFolder, menu])

  function selectedEntries(): SftpEntry[] {
    return entries.filter((e) => selected.has(e.path))
  }

  function onRowClick(e: ReactMouseEvent, entry: SftpEntry): void {
    e.stopPropagation()
    setSelected((prev) => {
      const next = new Set(prev)
      if (e.metaKey || e.ctrlKey) {
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
      } else if (e.shiftKey && lastClickedRef.current) {
        const from = entries.findIndex((x) => x.path === lastClickedRef.current)
        const to = entries.findIndex((x) => x.path === entry.path)
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from]
          for (let i = lo; i <= hi; i++) next.add(entries[i].path)
        }
      } else {
        next.clear()
        next.add(entry.path)
      }
      return next
    })
    lastClickedRef.current = entry.path
  }

  function onRowContextMenu(e: ReactMouseEvent, entry: SftpEntry): void {
    e.preventDefault()
    e.stopPropagation()
    // Right-clicking outside the current selection re-targets it to that row.
    const targets = selected.has(entry.path) ? selectedEntries() : [entry]
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]))
    setMenu({ x: e.clientX, y: e.clientY, entries: targets })
  }

  async function download(entry: SftpEntry): Promise<void> {
    const localPath = await window.td.dialogs.pickSavePath(entry.name)
    if (!localPath || !connectionId) return
    try {
      await window.td.sftp.download(connectionId, entry.path, localPath)
    } catch (err) {
      setError((err as Error).message)
    }
    setTransfer(null)
  }

  async function uploadPath(localPath: string): Promise<void> {
    if (!connectionId) return
    const name = localPath.split(/[/\\]/).pop() ?? 'file'
    await window.td.sftp.upload(connectionId, localPath, `${path.replace(/\/$/, '')}/${name}`)
  }

  async function upload(): Promise<void> {
    const localPath = await window.td.dialogs.pickOpenPath()
    if (!localPath) return
    try {
      await uploadPath(localPath)
    } catch (err) {
      setError((err as Error).message)
    }
    setTransfer(null)
    load(path)
  }

  async function onDrop(e: ReactDragEvent): Promise<void> {
    e.preventDefault()
    setDragging(false)
    if (!connectionId) return
    const paths = Array.from(e.dataTransfer.files).map((f) => window.td.files.pathFor(f))
    setError(null)
    try {
      // Sequential: fastPut on one SFTP channel doesn't like concurrent writers.
      for (const p of paths.filter(Boolean)) await uploadPath(p)
    } catch (err) {
      setError((err as Error).message)
    }
    setTransfer(null)
    load(path)
  }

  async function doDelete(targets: SftpEntry[]): Promise<void> {
    if (!connectionId) return
    setPendingDelete(null)
    setError(null)
    const failures: string[] = []
    for (const entry of targets) {
      try {
        await window.td.sftp.delete(connectionId, entry.path, entry.isDirectory)
      } catch (err) {
        // rmdir refuses non-empty directories; say so rather than failing silently.
        failures.push(`${entry.name}: ${(err as Error).message}`)
      }
    }
    if (failures.length > 0) setError(failures.join('; '))
    load(path)
  }

  async function doRename(): Promise<void> {
    if (!renaming || !connectionId) return
    const name = renaming.value.trim()
    if (!name || name === renaming.entry.name) {
      setRenaming(null)
      return
    }
    const dir = renaming.entry.path.split('/').slice(0, -1).join('/')
    try {
      await window.td.sftp.rename(connectionId, renaming.entry.path, `${dir}/${name}`)
    } catch (err) {
      setError((err as Error).message)
    }
    setRenaming(null)
    load(path)
  }

  async function doMkdir(): Promise<void> {
    if (newFolder === null || !connectionId) return
    const name = newFolder.trim()
    if (!name) {
      setNewFolder(null)
      return
    }
    try {
      await window.td.sftp.mkdir(connectionId, `${path.replace(/\/$/, '')}/${name}`)
    } catch (err) {
      setError((err as Error).message)
    }
    setNewFolder(null)
    load(path)
  }

  function sftpMenuItems(targets: SftpEntry[]): MenuItem[] {
    const items: MenuItem[] = []
    const only = targets.length === 1 ? targets[0] : undefined

    if (only && !only.isDirectory) {
      items.push({ label: 'Download', onSelect: () => download(only) })
    }
    if (only?.isDirectory) {
      items.push({ label: 'Open', onSelect: () => load(only.path) })
    }
    if (only) {
      items.push({
        label: 'Rename…',
        onSelect: () => setRenaming({ entry: only, value: only.name })
      })
    }
    if (targets.length > 0) {
      items.push({
        label: `Delete${targets.length > 1 ? ` ${targets.length} items` : ''}`,
        danger: true,
        onSelect: () => setPendingDelete(targets)
      })
    }

    items.push({
      label: 'New folder…',
      separated: targets.length > 0,
      onSelect: () => setNewFolder('')
    })
    items.push({ label: 'Upload file…', onSelect: upload })
    items.push({ label: 'Refresh', onSelect: () => refresh() })
    return items
  }

  const parentPath = path.split('/').slice(0, -1).join('/') || '/'

  return (
    <div
      className={`sftp-panel ${dragging ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, entries: [] })
      }}
      onClick={() => setSelected(new Set())}
    >
      <div className="sftp-path">
        <span className="sftp-path-text" title={path}>
          {path}
        </span>
        <button
          title="Refresh"
          onClick={(e) => {
            e.stopPropagation()
            refresh()
          }}
        >
          ⟳
        </button>
      </div>
      <div className="sftp-list">
        {path !== '.' && path !== '/' && (
          <div className="sftp-row" onDoubleClick={() => load(parentPath)}>
            <span className="name">..</span>
          </div>
        )}
        {entries.map((e) => (
          <div
            key={e.path}
            className={`sftp-row ${selected.has(e.path) ? 'selected' : ''}`}
            onClick={(ev) => onRowClick(ev, e)}
            onContextMenu={(ev) => onRowContextMenu(ev, e)}
            onDoubleClick={() => (e.isDirectory ? load(e.path) : download(e))}
            title={e.isDirectory ? 'Double-click to open' : 'Double-click to download'}
          >
            {renaming?.entry.path === e.path ? (
              <input
                autoFocus
                className="rename-input"
                value={renaming.value}
                onClick={(ev) => ev.stopPropagation()}
                onChange={(ev) => setRenaming({ entry: e, value: ev.target.value })}
                onBlur={doRename}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') doRename()
                  if (ev.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <>
                <span className="name">
                  {e.isDirectory ? '📁' : '📄'} {e.name}
                </span>
                {!e.isDirectory && <span className="size">{formatSize(e.size)}</span>}
              </>
            )}
          </div>
        ))}
        {newFolder !== null && (
          <div className="sftp-row">
            <input
              autoFocus
              className="rename-input"
              placeholder="New folder name"
              value={newFolder}
              onClick={(ev) => ev.stopPropagation()}
              onChange={(ev) => setNewFolder(ev.target.value)}
              onBlur={doMkdir}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') doMkdir()
                if (ev.key === 'Escape') setNewFolder(null)
              }}
            />
          </div>
        )}
      </div>

      {error && (
        <div className="error-text" style={{ padding: 6 }}>
          {error}
        </div>
      )}

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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={sftpMenuItems(menu.entries)}
          onClose={() => setMenu(null)}
        />
      )}

      {pendingDelete && (
        <ModalBackdrop onClose={() => setPendingDelete(null)}>
          <div className="modal-card" style={{ width: 380 }} onClick={(e) => e.stopPropagation()}>
            <h2>Delete {pendingDelete.length > 1 ? `${pendingDelete.length} items` : 'item'}?</h2>
            <p>
              This permanently removes the following from the remote host — it cannot be undone:
            </p>
            <div className="delete-list">
              {pendingDelete.map((e) => (
                <div key={e.path}>
                  {e.isDirectory ? '📁' : '📄'} {e.name}
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger" onClick={() => doDelete(pendingDelete)}>
                Delete
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  )
}
