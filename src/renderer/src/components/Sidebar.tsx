import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { DragEvent as ReactDragEvent } from 'react'
import type { SessionProfile } from '../../../shared/types'
import { useStore } from '../state/store'
import { DRAG_MIME, type DragItem } from '../state/dnd'
import SessionDialog from './SessionDialog'
import QuickConnectDialog from './QuickConnectDialog'
import ImportSshConfigDialog from './ImportSshConfigDialog'
import SettingsDialog from './SettingsDialog'
import ContextMenu, { type MenuItem } from './ContextMenu'
import ModalBackdrop from './ModalBackdrop'

const ROOT_TARGET = '__root__'
const COLLAPSED_KEY = 'terminaldeck.collapsedGroups'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

export default function Sidebar({
  onOpenSnippets
}: {
  onOpenSnippets: () => void
}): JSX.Element {
  const groups = useStore((s) => s.groups)
  const sessions = useStore((s) => s.sessions)
  const upsertGroup = useStore((s) => s.upsertGroup)
  const removeGroup = useStore((s) => s.removeGroup)
  const removeSession = useStore((s) => s.removeSession)
  const upsertSession = useStore((s) => s.upsertSession)
  const openTab = useStore((s) => s.openTab)
  const lockVault = useStore((s) => s.lockVault)
  const moveSession = useStore((s) => s.moveSession)
  const moveGroup = useStore((s) => s.moveGroup)

  const [editingSession, setEditingSession] = useState<SessionProfile | undefined | 'new'>(undefined)
  const [showQuickConnect, setShowQuickConnect] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [query, setQuery] = useState('')
  // undefined = dialog closed; null = creating a top-level group
  const [newGroupParent, setNewGroupParent] = useState<string | null | undefined>(undefined)
  const [groupName, setGroupName] = useState('')
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  function toggleCollapsed(groupId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  function connect(session: SessionProfile): void {
    openTab(session.name, { kind: 'session', sessionId: session.id })
  }

  async function submitGroup(): Promise<void> {
    const name = groupName.trim()
    if (!name || newGroupParent === undefined) return
    await upsertGroup({ id: nanoid(), name, parentId: newGroupParent })
    setNewGroupParent(undefined)
    setGroupName('')
  }

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? sessions.filter((s) =>
        [s.name, s.host, s.username, ...s.tags].some((f) => f.toLowerCase().includes(needle))
      )
    : sessions

  const rootSessions = visible.filter((s) => s.groupId === null)

  /** A group survives filtering if it, or any descendant, still holds a match. */
  function groupHasMatch(groupId: string): boolean {
    if (visible.some((s) => s.groupId === groupId)) return true
    return groups.filter((g) => g.parentId === groupId).some((g) => groupHasMatch(g.id))
  }

  function startDrag(e: ReactDragEvent, item: DragItem): void {
    e.stopPropagation()
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item))
    // Panes accept the same payload as a 'copy' (open here), the tree as a 'move'.
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  function allowDrop(e: ReactDragEvent, targetId: string | null): void {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(targetId ?? ROOT_TARGET)
  }

  async function handleDrop(e: ReactDragEvent, targetGroupId: string | null): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    const item = JSON.parse(raw) as DragItem
    if (item.kind === 'session') await moveSession(item.id, targetGroupId)
    else if (item.kind === 'group') await moveGroup(item.id, targetGroupId)
  }

  function sessionMenu(s: SessionProfile): MenuItem[] {
    const state = useStore.getState()
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId)
    return [
      { label: 'Connect', onSelect: () => connect(s) },
      {
        label: 'Connect in split',
        disabled: !activeTab,
        onSelect: () => {
          if (!activeTab) return
          state.splitPaneWith(
            activeTab.id,
            activeTab.activePaneId,
            'row',
            'after',
            s.name,
            { kind: 'session', sessionId: s.id }
          )
        }
      },
      {
        label: 'Duplicate',
        separated: true,
        onSelect: () => {
          const now = Date.now()
          // The clone gets its own id; the secret stays with the original, so the
          // copy has to be given credentials of its own.
          upsertSession({
            ...s,
            id: nanoid(),
            name: `${s.name} copy`,
            secretRef: undefined,
            createdAt: now,
            updatedAt: now
          })
        }
      },
      { label: 'Edit…', onSelect: () => setEditingSession(s) },
      {
        label: `Copy ${s.username ? `${s.username}@` : ''}${s.host}`,
        onSelect: () => {
          window.td.clipboard.write(`${s.username ? `${s.username}@` : ''}${s.host}`)
        }
      },
      { label: 'Delete', danger: true, separated: true, onSelect: () => removeSession(s.id) }
    ]
  }

  function groupMenu(groupId: string): MenuItem[] {
    return [
      { label: 'New session here', onSelect: () => setEditingSession('new') },
      { label: 'New subgroup…', onSelect: () => setNewGroupParent(groupId) },
      { label: 'Delete group', danger: true, separated: true, onSelect: () => removeGroup(groupId) }
    ]
  }

  function renderSession(s: SessionProfile, paddingLeft: number): JSX.Element {
    return (
      <div
        className="tree-item"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY, items: sessionMenu(s) })
        }}
        key={s.id}
        style={{ paddingLeft }}
        draggable
        onDragStart={(e) => startDrag(e, { kind: 'session', id: s.id })}
        onDoubleClick={() => connect(s)}
      >
        <span className="name" onClick={() => connect(s)}>
          🖥 {s.name}
        </span>
        <div className="actions">
          <button onClick={() => setEditingSession(s)}>Edit</button>
          <button onClick={() => removeSession(s.id)}>✕</button>
        </div>
      </div>
    )
  }

  function renderGroups(parentId: string | null, depth: number): JSX.Element[] {
    return groups
      .filter((g) => g.parentId === parentId)
      .filter((g) => !needle || groupHasMatch(g.id))
      .map((g) => {
        // While filtering, stay expanded — matches must not hide inside a closed group.
        const isCollapsed = needle === '' && collapsed.has(g.id)
        const childCount =
          visible.filter((s) => s.groupId === g.id).length +
          groups.filter((x) => x.parentId === g.id).length

        return (
          <div className="tree-group" key={g.id}>
            <div
              className={`tree-item ${dropTarget === g.id ? 'drop-target' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'group', id: g.id })}
              onDragOver={(e) => allowDrop(e, g.id)}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => handleDrop(e, g.id)}
              onClick={() => toggleCollapsed(g.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({ x: e.clientX, y: e.clientY, items: groupMenu(g.id) })
              }}
            >
              <span className="tree-group-title name">
                <span className="chevron">{isCollapsed ? '▸' : '▾'}</span> 📁 {g.name}
                {isCollapsed && childCount > 0 && <span className="child-count">{childCount}</span>}
              </span>
              <div className="actions">
                <button
                  title="New subgroup"
                  onClick={(e) => {
                    e.stopPropagation()
                    setNewGroupParent(g.id)
                  }}
                >
                  +
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    removeGroup(g.id)
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
            {!isCollapsed && (
              <>
                {visible
                  .filter((s) => s.groupId === g.id)
                  .map((s) => renderSession(s, 20 + depth * 12))}
                {renderGroups(g.id, depth + 1)}
              </>
            )}
          </div>
        )
      })
  }

  return (
    <div className="sidebar">
      <div className="titlebar-spacer" />
      <div className="sidebar-header">
        <button className="primary" style={{ flex: 1 }} onClick={() => setEditingSession('new')}>
          + Session
        </button>
        <button onClick={() => setNewGroupParent(null)}>+ Group</button>
        <button title="Import from ~/.ssh/config" onClick={() => setShowImport(true)}>
          ⇩
        </button>
      </div>
      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <button style={{ flex: 1 }} onClick={() => setShowQuickConnect(true)}>
          Quick connect…
        </button>
        <button title="Snippets (⌘K)" onClick={onOpenSnippets}>
          ⌘
        </button>
        <button title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
        <button title="Lock vault (⌘L)" onClick={() => lockVault()}>
          🔒
        </button>
      </div>
      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <input
          style={{ flex: 1 }}
          placeholder="Filter hosts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div
        className={`sidebar-tree ${dropTarget === ROOT_TARGET ? 'drop-target' : ''}`}
        onDragOver={(e) => allowDrop(e, null)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => handleDrop(e, null)}
      >
        {renderGroups(null, 0)}

        {rootSessions.length > 0 && (
          <div className="tree-group">
            <div className="tree-group-title">Sessions</div>
            {rootSessions.map((s) => renderSession(s, 8))}
          </div>
        )}

        {groups.length === 0 && sessions.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            No saved sessions yet. Click "+ Session" to add one.
          </div>
        )}
        {needle !== '' && visible.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            Nothing matches “{query}”.
          </div>
        )}
      </div>

      {editingSession !== undefined && (
        <SessionDialog
          initial={editingSession === 'new' ? undefined : editingSession}
          onClose={() => setEditingSession(undefined)}
        />
      )}
      {showQuickConnect && <QuickConnectDialog onClose={() => setShowQuickConnect(false)} />}
      {showImport && <ImportSshConfigDialog onClose={() => setShowImport(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {newGroupParent !== undefined && (
        <ModalBackdrop onClose={() => setNewGroupParent(undefined)}>
          <div
            className="modal-card"
            style={{ width: 340 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{newGroupParent === null ? 'New group' : 'New subgroup'}</h2>
            <label>
              Name
              <input
                autoFocus
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitGroup()
                  if (e.key === 'Escape') setNewGroupParent(undefined)
                }}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setNewGroupParent(undefined)}>Cancel</button>
              <button className="primary" onClick={submitGroup} disabled={!groupName.trim()}>
                Create
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
    </div>
  )
}
