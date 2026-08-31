import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { SftpEntry, TransferDecisions, TransferPlan } from '../../../shared/types'
import { parentOf, segmentsOf } from '../../../shared/remotePath'
import { formatChanged, formatPermissions, kindOf } from '../../../shared/permissions'
import { formatSize } from '../../../shared/fileSize'
import SftpTree from './SftpTree'
import ModalBackdrop from './ModalBackdrop'
import ContextMenu, { type MenuItem } from './ContextMenu'
import TransferConflictDialog from './TransferConflictDialog'
import DiffDialog from './DiffDialog'
import { useStore } from '../state/store'
import {
  SFTP_DRAG,
  acceptsDrop,
  beginDrag,
  draggedNow,
  endDrag,
  type SftpDragPayload
} from '../state/sftpDrag'
import { useT } from '../i18n'
import {
  COLUMNS,
  MAX_COL,
  PANEL_MAX,
  PANEL_MIN,
  TREE_MAX,
  TREE_MIN,
  col,
  clamp,
  loadColumns,
  loadPanelWidth,
  loadTreeOpen,
  loadTreeWidth,
  minRowWidth,
  minWidthOf,
  saveColumns,
  savePanelWidth,
  saveTreeOpen,
  saveTreeWidth,
  type ColumnWidths
} from '../state/sftpLayout'

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
  const t = useT()
  const externalEditor = useStore((s) => s.settings.externalEditor)
  const [path, setPath] = useState('.')
  /** What is in the path box, which may differ from `path` while being edited. */
  const [draftPath, setDraftPath] = useState('.')
  const [entries, setEntries] = useState<SftpEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [transfer, setTransfer] = useState<Transfer | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * The folder under the pointer during a drag, which a drop lands in instead of
   * the directory being listed. Null means the panel's own current directory.
   */
  const [dropDir, setDropDir] = useState<string | null>(null)
  /** Remote paths currently open in a local editor. */
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<{ entry: SftpEntry; value: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SftpEntry[] | null>(null)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  /** A planned transfer waiting on an answer about what it would overwrite. */
  const [pendingTransfer, setPendingTransfer] = useState<{
    plan: TransferPlan
    /** The host the files come from, when they come from another one. */
    source?: string
  } | null>(null)
  /** A file being compared, remote against local. */
  const [comparing, setComparing] = useState<{ remote: string; local: string } | null>(null)
  /**
   * Whether this connection is tracking the shell's directory. The host setting
   * only decides how it starts; from here on it is a property of the live
   * connection, switched right where the directory is being looked at.
   */
  const [following, setFollowing] = useState(false)
  const [treeOpen, setTreeOpen] = useState(loadTreeOpen)
  const [width, setWidth] = useState(loadPanelWidth)
  const [treeWidth, setTreeWidth] = useState(loadTreeWidth)
  const [columns, setColumns] = useState<ColumnWidths>(loadColumns)
  const rowWidth = minRowWidth(columns)
  const lastClickedRef = useRef<string | null>(null)
  /** Read inside the cwd listener, which is registered once per connection. */
  const pathRef = useRef(path)
  pathRef.current = path

  /**
   * One drag, wherever the grip is. `sign` is -1 for a handle on the left of
   * what it sizes — the panel's own edge, which widens as the pointer goes
   * left — and 1 for the ordinary case of a grip on the right.
   *
   * Every width is remembered: a layout arranged once should survive closing
   * the panel, and the next connection.
   */
  function startDrag(
    down: React.MouseEvent,
    from: number,
    sign: 1 | -1,
    min: number,
    max: number,
    apply: (next: number) => void,
    persist: (final: number) => void
  ): void {
    down.preventDefault()
    down.stopPropagation()
    const startX = down.clientX
    let latest = from
    const onMove = (move: MouseEvent): void => {
      latest = clamp(from + (move.clientX - startX) * sign, min, max)
      apply(latest)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Held on the body so the cursor does not flicker while the pointer is
      // dragged off the grip and over the terminal.
      document.body.style.cursor = ''
      persist(latest)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function resizeColumn(key: keyof ColumnWidths, down: React.MouseEvent): void {
    startDrag(
      down,
      columns[key],
      1,
      minWidthOf(key),
      MAX_COL,
      (next) => setColumns((cur) => ({ ...cur, [key]: next })),
      (final) => saveColumns({ ...columns, [key]: final })
    )
  }

  function toggleTree(): void {
    setTreeOpen((open) => {
      saveTreeOpen(!open)
      return !open
    })
  }

  useEffect(() => {
    if (!connectionId) return
    const off = window.td.sftp.onProgress(connectionId, (p) => {
      setTransfer(p.transferred >= p.total ? null : p)
    })
    return off
  }, [connectionId])

  // The shell's own directory, reported only for profiles that asked to follow.
  useEffect(() => {
    if (!connectionId) return
    // Main only reports a directory while following is on, so anything arriving
    // here is wanted. A no-op when the panel is already there, which is the
    // common case: the shell says where it is on every prompt, not only on cd.
    return window.td.ssh.onCwd(connectionId, (cwd) => {
      if (pathRef.current === cwd) return
      load(cwd)
    })
    // `load` is redeclared every render and is left out on purpose: listing it
    // would drop and re-add this subscription on every keystroke in the panel.
    // The one value it needs to be current about is the path, which it reads
    // from a ref rather than from the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  useEffect(() => {
    if (!connectionId) return
    return window.td.sftp.onEdited(connectionId, (p) => {
      if (p.error) {
        setError(`${p.remotePath.split('/').pop()}: ${p.error}`)
        return
      }
      const name = p.remotePath.split('/').pop() ?? p.remotePath
      setSaved(name)
      // The banner is an acknowledgement, not a state; let it fade.
      setTimeout(() => setSaved((cur) => (cur === name ? null : cur)), 2500)
    })
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
    setDraftPath(p)
    setSelected(new Set())
    await fetchList(p, false)
  }

  /**
   * Go wherever the user typed. The path is resolved by the server rather than
   * by us, so `~`, `..` and symlinks behave as they would in the remote shell.
   * A path pointing at a file opens its directory and selects it, which is what
   * pasting a path out of a log is usually for.
   */
  async function navigateTo(typed: string): Promise<void> {
    if (!connectionId) return
    const wanted = typed.trim()
    if (!wanted) return
    try {
      const resolved = await window.td.sftp.realpath(connectionId, wanted)
      const info = await window.td.sftp.stat(connectionId, resolved)
      if (info && !info.isDirectory) {
        await load(parentOf(resolved))
        setSelected(new Set([resolved]))
        return
      }
      await load(resolved)
    } catch (err) {
      // The typed text is deliberately left alone: a typo should be fixable,
      // not snapped back to the old path for retyping.
      setError((err as Error).message)
    }
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

  // The host's setting decided how this connection started; ask what it is now.
  useEffect(() => {
    if (!connectionId) return
    window.td.ssh.getFollowCwd(connectionId).then(setFollowing).catch(() => undefined)
  }, [connectionId])

  async function toggleFollow(): Promise<void> {
    if (!connectionId) return
    setFollowing(await window.td.ssh.setFollowCwd(connectionId, !following))
  }

  useEffect(() => {
    if (!connectionId) return
    // SFTP opens on '.', which is usually the home directory but need not be.
    // Resolving it once means the panel can say where it actually is.
    window.td.sftp
      .realpath(connectionId, '.')
      .then((resolved) => load(resolved))
      .catch(() => load('.'))
    // Once per connection, which is what `[connectionId]` says. `load` is left
    // out for the same reason as above; listing it would send the panel back to
    // the home directory on every render.
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
    // Everything `refresh` reads that can change — the connection and the path —
    // is listed, so the timer is rebuilt when they do. `refresh` itself is not:
    // a new identity every render would restart the five-second clock on every
    // render, which is a poll that never fires.
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

  /**
   * Plans a transfer, asks about anything it would trample, then runs it.
   * Every batch asks afresh — no answer is remembered between transfers, so a
   * decision made once in a hurry never governs a later copy.
   */
  async function runTransfer(plan: TransferPlan, source?: string): Promise<void> {
    if (plan.items.length === 0) return
    if (plan.conflicts.length === 0 && plan.collisions.length === 0) {
      await execute(plan, {}, source)
      return
    }
    setPendingTransfer({ plan, source })
  }

  /**
   * `source` is the host a relayed batch comes from. It leads the call because
   * `runPlan` reads from the first connection and writes to the second, and for
   * a relay this panel is the writing end.
   */
  async function execute(
    plan: TransferPlan,
    decisions: TransferDecisions,
    source?: string
  ): Promise<void> {
    if (!connectionId) return
    setPendingTransfer(null)
    setError(null)
    try {
      await window.td.sftp.runPlan(
        source ?? connectionId,
        plan,
        decisions,
        source ? connectionId : undefined
      )
    } catch (err) {
      setError((err as Error).message)
    }
    setTransfer(null)
    if (plan.direction !== 'download') load(path)
  }

  async function planAndUpload(localPaths: string[], destination = path): Promise<void> {
    if (!connectionId) return
    setError(null)
    try {
      // Sequential on purpose: fastPut on one SFTP channel dislikes concurrent
      // writers, and one dialog per dropped item is clearer than one merged.
      for (const localPath of localPaths.filter(Boolean)) {
        await runTransfer(await window.td.sftp.planUpload(connectionId, localPath, destination))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /**
   * Copies paths from another connected host into `destination` on this one.
   *
   * The two servers need no route to each other: the bytes are streamed through
   * this process, source socket to destination socket, without being staged on
   * disk on the way.
   */
  async function planAndRelay(payload: SftpDragPayload, destination: string): Promise<void> {
    if (!connectionId || payload.connectionId === connectionId) return
    setError(null)
    try {
      // One plan per dropped item, for the same reason uploads are sequential:
      // a single merged dialog would hide which item each clash belongs to.
      for (const remotePath of payload.paths) {
        await runTransfer(
          await window.td.sftp.planRelay(
            payload.connectionId,
            remotePath,
            connectionId,
            destination
          ),
          payload.connectionId
        )
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function download(entry: SftpEntry): Promise<void> {
    if (!connectionId) return
    // A folder needs a destination directory; a file needs a destination filename.
    const localPath = entry.isDirectory
      ? await window.td.dialogs.pickDirectory()
      : await window.td.dialogs.pickSavePath(entry.name)
    if (!localPath) return
    setError(null)
    try {
      // A folder mirrors into a directory; a single file goes to the exact name
      // the save dialog returned, and is checked against that name.
      await runTransfer(
        entry.isDirectory
          ? await window.td.sftp.planDownload(connectionId, entry.path, `${localPath}/${entry.name}`)
          : await window.td.sftp.planDownload(connectionId, entry.path, localPath, true)
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Opens the file in the local editor; saves are pushed back automatically. */
  async function edit(entry: SftpEntry): Promise<void> {
    if (!connectionId) return
    setError(null)
    try {
      await window.td.sftp.edit(connectionId, entry.path, externalEditor)
      setEditing((prev) => new Set(prev).add(entry.path))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function upload(): Promise<void> {
    const localPath = await window.td.dialogs.pickOpenPath()
    if (localPath) await planAndUpload([localPath])
  }

  async function uploadFolder(): Promise<void> {
    const localPath = await window.td.dialogs.pickDirectory()
    if (localPath) await planAndUpload([localPath])
  }

  /** Starts dragging rows out towards another host's panel. */
  function onRowDragStart(e: ReactDragEvent, entry: SftpEntry): void {
    if (!connectionId) return
    // Dragging a row outside the selection takes that row alone, matching what
    // right-clicking one does.
    const targets = selected.has(entry.path) ? selectedEntries() : [entry]
    const payload = beginDrag({ connectionId, paths: targets.map((entry) => entry.path) })
    e.dataTransfer.setData(SFTP_DRAG, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  /**
   * Whether this panel wants what is being dragged: files from the desktop, or
   * rows from a *different* host. Rows from this same connection are declined —
   * dropping a file back onto its own host would be a copy onto itself.
   */
  function acceptsDrag(e: ReactDragEvent): boolean {
    return acceptsDrop(e.dataTransfer.types, draggedNow()?.connectionId, connectionId)
  }

  /** Marks a folder row as where the drop would land, instead of the listing. */
  function onFolderDragOver(e: ReactDragEvent, entry: SftpEntry): void {
    if (!acceptsDrag(e)) return
    e.preventDefault()
    // Stops the panel's own handler from immediately clearing the folder again;
    // moving back off the row lets it run and reset this.
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
    setDropDir(entry.path)
  }

  async function onDrop(e: ReactDragEvent): Promise<void> {
    e.preventDefault()
    const destination = dropDir ?? path
    setDragging(false)
    setDropDir(null)
    if (!connectionId) return

    const raw = e.dataTransfer.getData(SFTP_DRAG)
    if (raw) {
      try {
        await planAndRelay(JSON.parse(raw) as SftpDragPayload, destination)
      } catch (err) {
        setError((err as Error).message)
      }
      return
    }
    const paths = Array.from(e.dataTransfer.files).map((f) => window.td.files.pathFor(f))
    await planAndUpload(paths, destination)
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

    if (only?.isDirectory) {
      items.push({ label: t('Open'), onSelect: () => load(only.path) })
      items.push({ label: t('Download folder…'), onSelect: () => download(only) })
    }
    if (only && !only.isDirectory) {
      items.push({ label: t('Edit locally'), onSelect: () => edit(only) })
      items.push({ label: t('Download'), onSelect: () => download(only) })
    }
    if (only) {
      items.push({
        label: t('Rename…'),
        onSelect: () => setRenaming({ entry: only, value: only.name })
      })
    }
    if (only && !only.isDirectory) {
      items.push({
        label: t('Compare with a local file…'),
        onSelect: async () => {
          const local = await window.td.dialogs.pickOpenPath()
          if (local) setComparing({ remote: only.path, local })
        }
      })
    }
    if (targets.length > 0) {
      items.push({
        label:
          targets.length > 1 ? t('Delete {count} items', { count: targets.length }) : t('Delete'),
        danger: true,
        onSelect: () => setPendingDelete(targets)
      })
    }

    items.push({
      label: t('New folder…'),
      separated: targets.length > 0,
      onSelect: () => setNewFolder('')
    })
    items.push({ label: t('Upload file…'), onSelect: upload })
    items.push({ label: t('Upload folder…'), onSelect: uploadFolder })
    items.push({ label: t('Refresh'), onSelect: () => refresh() })
    return items
  }

  return (
    <div
      className={`sftp-panel ${dragging ? 'drop-target' : ''}`}
      style={{ width }}
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
        setDropDir(null)
      }}
      onDragLeave={(e) => {
        // Crossing between the panel's own children fires dragleave too; only a
        // pointer that has actually left the panel should drop the highlight.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
        setDropDir(null)
      }}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY, entries: [] })
      }}
      onClick={() => setSelected(new Set())}
    >
      <div
        className="sftp-resize"
        title={t('Drag to resize the panel')}
        onMouseDown={(e) =>
          startDrag(e, width, -1, PANEL_MIN, PANEL_MAX, setWidth, (final) =>
            savePanelWidth(final)
          )
        }
      />
      <div className="sftp-path" onClick={(e) => e.stopPropagation()}>
        <button
          className={treeOpen ? 'active' : ''}
          title={treeOpen ? t('Hide the folder tree') : t('Show the folder tree')}
          onClick={toggleTree}
        >
          ⊞
        </button>
        <button
          title={t('Up one level')}
          disabled={path === '/' || path === '.'}
          onClick={() => load(parentOf(path))}
        >
          ↑
        </button>
        <input
          className="sftp-path-input"
          value={draftPath}
          spellCheck={false}
          title={path}
          onChange={(e) => setDraftPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigateTo(draftPath)
            if (e.key === 'Escape') {
              setDraftPath(path)
              e.currentTarget.blur()
            }
          }}
        />
        <button
          className={following ? 'active' : ''}
          disabled={!connectionId}
          title={
            following
              ? t('Following the terminal’s directory — click to stop')
              : t('Follow the terminal’s directory (sends a setup line to the shell)')
          }
          onClick={toggleFollow}
        >
          ⇉
        </button>
        <button title={t('Refresh')} onClick={() => refresh()}>
          ⟳
        </button>
      </div>

      <div className="sftp-crumbs" onClick={(e) => e.stopPropagation()}>
        {segmentsOf(path).map((crumb, i, all) => (
          <span key={crumb.path}>
            <button
              className="crumb"
              disabled={i === all.length - 1}
              title={crumb.path}
              onClick={() => load(crumb.path)}
            >
              {crumb.name}
            </button>
            {i < all.length - 1 && crumb.name !== '/' && <span className="crumb-sep">/</span>}
          </span>
        ))}
      </div>
      <div className="sftp-body">
        {treeOpen && (
          <>
            <div style={{ width: treeWidth }} className="sftp-tree-wrap">
              <SftpTree connectionId={connectionId} path={path} onOpen={(p) => load(p)} />
            </div>
            <div
              className="sftp-split"
              title={t('Drag to resize the tree')}
              onMouseDown={(e) =>
                startDrag(e, treeWidth, 1, TREE_MIN, TREE_MAX, setTreeWidth, (final) =>
                  saveTreeWidth(final)
                )
              }
            />
          </>
        )}
        <div className="sftp-list">
          <div className="sftp-head" style={{ minWidth: rowWidth }}>
            {COLUMNS.map(([key, label]) => (
              <span key={key} className={`head-cell ${key}`} style={col(columns[key])}>
                {t(label)}
                <span
                  className="col-grip"
                  title={t('Drag to resize {column}', { column: t(label) })}
                  onMouseDown={(e) => resizeColumn(key, e)}
                />
              </span>
            ))}
          </div>
          {path !== '.' && path !== '/' && (
            <div
              className="sftp-row"
              style={{ minWidth: rowWidth }}
              onDoubleClick={() => load(parentOf(path))}
            >
              <span className="name" style={col(columns.name)}>
                ..
              </span>
            </div>
          )}
          {entries.map((e) => (
            <div
              key={e.path}
              className={`sftp-row ${selected.has(e.path) ? 'selected' : ''} ${
                dropDir === e.path ? 'drop-into' : ''
              }`}
              style={{ minWidth: rowWidth }}
              draggable={!renaming}
              onDragStart={(ev) => onRowDragStart(ev, e)}
              onDragEnd={() => {
                endDrag()
                setDragging(false)
                setDropDir(null)
              }}
              onDragOver={e.isDirectory ? (ev) => onFolderDragOver(ev, e) : undefined}
              onClick={(ev) => onRowClick(ev, e)}
              onContextMenu={(ev) => onRowContextMenu(ev, e)}
              onDoubleClick={() => (e.isDirectory ? load(e.path) : download(e))}
              title={
                e.isDirectory
                  ? t('Double-click to open, or drag onto another host’s panel to copy')
                  : t('Double-click to download, or drag onto another host’s panel to copy')
              }
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
                  <span className={`name kind-${kindOf(e)}`} style={col(columns.name)} title={e.name}>
                    {e.isDirectory ? '📁' : '📄'} {e.name}
                    {editing.has(e.path) && (
                      <span
                        className="no-inherit"
                        title={t('Open in a local editor; saves upload')}
                      >
                        ✎
                      </span>
                    )}
                  </span>
                  <span className="size" style={col(columns.size)}>
                    {e.isDirectory ? '' : formatSize(e.size)}
                  </span>
                  <span className="changed" style={col(columns.changed)}>
                    {formatChanged(e.mtime)}
                  </span>
                  <span
                    className={`perms kind-${kindOf(e)}`}
                    style={col(columns.perms)}
                    title={t('Mode {mode}', { mode: e.permissions })}
                  >
                    {formatPermissions(e.permissions)}
                  </span>
                  <span className={`owner kind-${kindOf(e)}`} style={col(columns.owner)}>
                    {e.owner}
                  </span>
                  <span className="group" style={col(columns.group)}>
                    {e.group}
                  </span>
                </>
              )}
            </div>
          ))}
          {newFolder !== null && (
            <div className="sftp-row" style={{ minWidth: rowWidth }}>
              <input
                autoFocus
                className="rename-input"
                placeholder={t('New folder name')}
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
      </div>

      {error && (
        <div className="error-text" style={{ padding: 6 }}>
          {error}
        </div>
      )}

      {pendingTransfer && (
        <TransferConflictDialog
          plan={pendingTransfer.plan}
          onCompare={(remote, local) => setComparing({ remote, local })}
          onCancel={() => setPendingTransfer(null)}
          onConfirm={(decisions) =>
            execute(pendingTransfer.plan, decisions, pendingTransfer.source)
          }
        />
      )}

      {comparing && connectionId && (
        <DiffDialog
          connectionId={connectionId}
          remotePath={comparing.remote}
          localPath={comparing.local}
          onClose={() => setComparing(null)}
        />
      )}

      {saved && <div className="sftp-saved">{t('Uploaded {name}', { name: saved })}</div>}

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
          {t('Upload file…')}
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
            <h2>
              {pendingDelete.length > 1
                ? t('Delete {count} items?', { count: pendingDelete.length })
                : t('Delete item?')}
            </h2>
            <p>
              {t(
                'This permanently removes the following from the remote host — it cannot be undone:'
              )}
            </p>
            <div className="delete-list">
              {pendingDelete.map((e) => (
                <div key={e.path}>
                  {e.isDirectory ? '📁' : '📄'} {e.name}
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button onClick={() => setPendingDelete(null)}>{t('Cancel')}</button>
              <button className="danger" onClick={() => doDelete(pendingDelete)}>
                {t('Delete')}
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  )
}
