import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { SessionGroup, SessionProfile } from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import {
  useStore,
  collectConnectedSessionIds,
  activeTab as currentTab,
  allRoots
} from '../state/store'
import { DRAG_MIME, type DragItem } from '../state/dnd'
import SessionDialog from './SessionDialog'
import QuickConnectDialog from './QuickConnectDialog'
import ImportSshConfigDialog from './ImportSshConfigDialog'
import GroupDialog from './GroupDialog'
import InventoryTree from './InventoryTree'
import CollectionsPanel from './CollectionsPanel'
import CollectionDialog from './CollectionDialog'
import SettingsDialog from './SettingsDialog'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { keyHint } from '../state/keys'

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
  onOpenSnippets,
  onOpenHelp
}: {
  onOpenSnippets: () => void
  onOpenHelp: () => void
}): JSX.Element {
  const groups = useStore((s) => s.groups)
  const sessions = useStore((s) => s.sessions)
  const removeGroup = useStore((s) => s.removeGroup)
  const removeSession = useStore((s) => s.removeSession)
  const upsertSession = useStore((s) => s.upsertSession)
  const openTab = useStore((s) => s.openTab)
  const lockVault = useStore((s) => s.lockVault)
  const moveSession = useStore((s) => s.moveSession)
  const reorderSession = useStore((s) => s.reorderSession)
  const moveGroup = useStore((s) => s.moveGroup)
  const selectedHostIds = useStore((s) => s.selectedHostIds)
  const toggleHostSelection = useStore((s) => s.toggleHostSelection)
  const selectOnlyHost = useStore((s) => s.selectOnlyHost)
  const selectHostRange = useStore((s) => s.selectHostRange)
  const clearHostSelection = useStore((s) => s.clearHostSelection)
  const openSelectedHosts = useStore((s) => s.openSelectedHosts)
  const openMany = useStore((s) => s.openMany)
  const collections = useStore((s) => s.collections)
  const addToCollection = useStore((s) => s.addToCollection)
  const workspaces = useStore((s) => s.workspaces)

  // Which hosts already have a terminal open anywhere, so the tree says so.
  const connected = new Set(
    allRoots({ workspaces }).flatMap(collectConnectedSessionIds)
  )

  const [editingSession, setEditingSession] = useState<SessionProfile | undefined | 'new'>(undefined)
  const [showQuickConnect, setShowQuickConnect] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [query, setQuery] = useState('')
  const [groupDialog, setGroupDialog] = useState<
    { group?: SessionGroup; parentId: string | null } | null
  >(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** The gap a host is about to land in: which row, and which side of it. */
  const [dropEdge, setDropEdge] = useState<{ id: string; place: 'before' | 'after' } | null>(null)
  /**
   * What is being dragged right now. dragover only exposes the MIME type, not
   * the payload, so telling a host drag from a group drag needs this.
   */
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [tab, setTab] = useState<'sessions' | 'inventory'>('sessions')
  /** Hosts waiting to be put into a brand new collection. */
  const [collecting, setCollecting] = useState<string[] | null>(null)

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
    openTab(session.name, { kind: 'session', sessionId: session.id }, session.color)
  }

  /** user@host as it will actually be used, inheritance included. */
  function addressOf(s: SessionProfile): string {
    const { username } = resolveAuth(s, s.groupId, groups)
    return username ? `${username}@${s.host}` : s.host
  }

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? sessions.filter((s) =>
        [s.name, s.host, addressOf(s), ...s.tags].some((f) => f.toLowerCase().includes(needle))
      )
    : sessions

  const rootSessions = visible.filter((s) => s.groupId === null)

  /** Ids in the order they appear on screen, so Shift-click can take a range. */
  function flattenOrder(parentId: string | null): string[] {
    const out: string[] = []
    for (const g of groups
      .filter((x) => x.parentId === parentId)
      .filter((g) => !needle || groupHasMatch(g.id))) {
      if (needle === '' && collapsed.has(g.id)) continue
      out.push(...visible.filter((s) => s.groupId === g.id).map((s) => s.id))
      out.push(...flattenOrder(g.id))
    }
    return out
  }

  function onSessionClick(e: ReactMouseEvent, s: SessionProfile): void {
    if (e.metaKey || e.ctrlKey) {
      toggleHostSelection(s.id)
      return
    }
    if (e.shiftKey) {
      selectHostRange([...flattenOrder(null), ...rootSessions.map((x) => x.id)], s.id)
      return
    }
    // Selects, never connects: opening a host is a double-click, so that a
    // stray click on the tree cannot start a session by itself.
    selectOnlyHost(s.id)
  }

  /**
   * Deleting is permanent and the secret goes with it, so it always asks first
   * — and it lives in the context menu only, never as a button on the row.
   */
  async function deleteSessions(ids: string[]): Promise<void> {
    const names = ids
      .map((id) => sessions.find((s) => s.id === id)?.name)
      .filter((n): n is string => Boolean(n))
    if (names.length === 0) return
    const what =
      names.length === 1 ? `“${names[0]}”` : `${names.length} hosts:\n\n${names.join('\n')}`
    if (!window.confirm(`Delete ${what}?\n\nThis cannot be undone.`)) return
    for (const id of ids) await removeSession(id)
    clearHostSelection()
  }

  /** A group survives filtering if it, or any descendant, still holds a match. */
  function groupHasMatch(groupId: string): boolean {
    if (visible.some((s) => s.groupId === groupId)) return true
    return groups.filter((g) => g.parentId === groupId).some((g) => groupHasMatch(g.id))
  }

  function startDrag(e: ReactDragEvent, item: DragItem, label: string): void {
    e.stopPropagation()
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item))
    // Panes accept the same payload as a 'copy' (open here), the tree as a 'move'.
    e.dataTransfer.effectAllowed = 'copyMove'
    setIsDragging(true)
    setDragItem(item)

    // The default drag image is the row plus whatever it contains, which reads
    // as though the branch is moving. A plain chip says exactly what is moving.
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    ghost.textContent = label
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 12, 14)
    // Removed once the browser has taken its snapshot.
    setTimeout(() => ghost.remove(), 0)
  }

  function endDrag(): void {
    setIsDragging(false)
    setDragItem(null)
    setDropTarget(null)
    setDropEdge(null)
  }

  function allowDrop(e: ReactDragEvent, targetId: string | null): void {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(targetId ?? ROOT_TARGET)
    setDropEdge(null)
  }

  /** Above the middle of a row means before it, below means after it. */
  function placeFor(e: ReactDragEvent): 'before' | 'after' {
    const rect = e.currentTarget.getBoundingClientRect()
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  /**
   * Hosts are sorted by dropping them into the gap between two rows. Only a host
   * drag does this — a group dragged over a host row still means nothing, so it
   * falls through to the group it is over.
   */
  function allowReorder(e: ReactDragEvent, target: SessionProfile): void {
    if (!dragItem || dragItem.kind !== 'session' || dragItem.id === target.id) return
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(null)
    // dragover fires continuously; keeping the same object while the gap has not
    // changed spares the whole tree a redraw on every mouse move.
    const place = placeFor(e)
    setDropEdge((cur) =>
      cur?.id === target.id && cur.place === place ? cur : { id: target.id, place }
    )
  }

  async function handleReorderDrop(e: ReactDragEvent, target: SessionProfile): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    const place = placeFor(e)
    setDropEdge(null)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    const item = JSON.parse(raw) as DragItem
    if (item.kind !== 'session' || item.id === target.id) return
    await reorderSession(item.id, target.id, place)
  }

  async function handleDrop(e: ReactDragEvent, targetGroupId: string | null): Promise<void> {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    setDropEdge(null)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    const item = JSON.parse(raw) as DragItem
    if (item.kind === 'session') await moveSession(item.id, targetGroupId)
    else if (item.kind === 'group') await moveGroup(item.id, targetGroupId)
  }

  function sessionMenu(s: SessionProfile): MenuItem[] {
    const state = useStore.getState()
    const activeTab = currentTab(state)
    // Right-clicking inside a selection acts on the whole of it; right-clicking
    // outside one acts on that row alone, whatever else happens to be ticked.
    const targets = selectedHostIds.includes(s.id)
      ? selectedHostIds.filter((id) => sessions.some((x) => x.id === id))
      : [s.id]
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
            { kind: 'session', sessionId: s.id },
            s.color
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
        label: `Copy ${addressOf(s)}`,
        onSelect: () => window.td.clipboard.write(addressOf(s))
      },
      {
        label: targets.length > 1 ? `Delete ${targets.length} hosts…` : 'Delete…',
        danger: true,
        separated: true,
        onSelect: () => deleteSessions(targets)
      }
    ]
  }

  /** The group and everything nested under it. A fixpoint, so a cycle cannot hang it. */
  function groupSubtree(groupId: string): Set<string> {
    const ids = new Set([groupId])
    let grew = true
    while (grew) {
      grew = false
      for (const g of groups) {
        if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id)
          grew = true
        }
      }
    }
    return ids
  }

  function groupMenu(groupId: string): MenuItem[] {
    const group = groups.find((g) => g.id === groupId)
    const inGroup = groupSubtree(groupId)
    const hosts = sessions.filter((s) => s.groupId && inGroup.has(s.groupId))
    return [
      {
        label: `Open all in a new workspace (${hosts.length})`,
        disabled: hosts.length === 0,
        onSelect: () =>
          openMany(
            hosts.map((s) => ({
              title: s.name,
              target: { kind: 'session' as const, sessionId: s.id },
              color: s.color
            })),
            'workspace',
            group?.name
          )
      },
      {
        label: 'Edit group…',
        separated: true,
        disabled: !group,
        onSelect: () => group && setGroupDialog({ group, parentId: group.parentId })
      },
      { label: 'New session here', onSelect: () => setEditingSession('new') },
      { label: 'New subgroup…', onSelect: () => setGroupDialog({ parentId: groupId }) },
      {
        label: 'Delete group…',
        danger: true,
        separated: true,
        onSelect: () => {
          // The hosts survive — they move up to the parent — so the prompt says so.
          const moved = sessions.filter((s) => s.groupId === groupId).length
          const note = moved > 0 ? `\n\nIts ${moved} host(s) move up a level; nothing is lost.` : ''
          if (window.confirm(`Delete the group “${group?.name ?? ''}”?${note}`)) removeGroup(groupId)
        }
      }
    ]
  }

  function renderSession(s: SessionProfile, paddingLeft: number): JSX.Element {
    const edge = dropEdge?.id === s.id ? ` drop-${dropEdge.place}` : ''
    return (
      <div
        className={`tree-item ${selectedHostIds.includes(s.id) ? 'selected' : ''}${edge}`}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenu({ x: e.clientX, y: e.clientY, items: sessionMenu(s) })
        }}
        key={s.id}
        style={{ paddingLeft }}
        draggable
        onDragStart={(e) => startDrag(e, { kind: 'session', id: s.id }, s.name)}
        onDragEnd={endDrag}
        onDragOver={(e) => allowReorder(e, s)}
        onDragLeave={() => setDropEdge((cur) => (cur?.id === s.id ? null : cur))}
        onDrop={(e) => handleReorderDrop(e, s)}
        onClick={(e) => onSessionClick(e, s)}
        onDoubleClick={() => connect(s)}
        title="Double-click to connect · drag to sort or to move between groups"
      >
        <span className="name">
          <span
            className="session-dot"
            style={s.color ? { background: s.color } : undefined}
            aria-hidden="true"
          />
          {s.name}
          {connected.has(s.id) && <span className="live-dot" title="Connected" />}
          {s.groupId && s.inheritAuth === false && (
            <span className="no-inherit" title="Does not inherit settings from its group">
              ⊘
            </span>
          )}
        </span>
        {/* No delete button here on purpose: one stray click must not be able
            to destroy a host. Deleting is in the context menu, behind a prompt. */}
        <div className="actions">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setEditingSession(s)
            }}
          >
            Edit
          </button>
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
              onDragStart={(e) => startDrag(e, { kind: 'group', id: g.id }, g.name)}
              onDragEnd={endDrag}
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
                    setGroupDialog({ parentId: g.id })
                  }}
                >
                  +
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

      <div className="sidebar-tabs">
        <button className={tab === 'sessions' ? 'active' : ''} onClick={() => setTab('sessions')}>
          Sessions
        </button>
        <button className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}>
          Inventory
        </button>
      </div>

      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <input
          style={{ flex: 1 }}
          placeholder={tab === 'sessions' ? 'Filter hosts…' : 'Filter inventory…'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {tab === 'inventory' && <InventoryTree query={query} />}

      {tab === 'sessions' && (
        <>
      <div className="sidebar-header">
        <button className="primary" style={{ flex: 1 }} onClick={() => setEditingSession('new')}>
          + Session
        </button>
        <button onClick={() => setGroupDialog({ parentId: null })}>+ Group</button>
        <button title="Import from ~/.ssh/config" onClick={() => setShowImport(true)}>
          ⇩
        </button>
      </div>
      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <button style={{ flex: 1 }} onClick={() => setShowQuickConnect(true)}>
          Quick connect…
        </button>
      </div>
      <div className="sidebar-tree">
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

        {/* An explicit strip, rather than outlining the whole tree, which made
            it look as though the entire structure were being moved. */}
        {isDragging && (
          <div
            className={`root-drop-zone ${dropTarget === ROOT_TARGET ? 'over' : ''}`}
            onDragOver={(e) => allowDrop(e, null)}
            onDragLeave={() => setDropTarget(null)}
            onDrop={(e) => handleDrop(e, null)}
          >
            Move to top level
          </div>
        )}

        {/* Custom sets live in the same tree as the groups, below them: they are
            another way of grouping the very same hosts, not a separate place. */}
        <CollectionsPanel query={query} />
      </div>
        </>
      )}

      {/* Only once there is a batch to act on. Every verb here is about several
          hosts at once, and one host is opened by clicking it — so for a single
          selection the bar offered nothing and took a row of the sidebar. */}
      {selectedHostIds.length > 1 && (
        <div className="selection-bar">
          <span className="count">{selectedHostIds.length} selected</span>
          <span style={{ flex: 1 }} />
          <button className="icon-button" title="Clear" onClick={clearHostSelection}>
            ✕
          </button>
          {/* The four verbs cannot fit beside the count in a sidebar this narrow,
              so they take a row of their own and wrap within it. */}
          <div className="selection-actions">
            <button
              title="Each in its own tab, in the current workspace"
              onClick={() => openSelectedHosts('tabs')}
            >
              Open
            </button>
            <button title="All tiled in one tab" onClick={() => openSelectedHosts('grid')}>
              Tile
            </button>
            <button
              title="A new workspace with a tab per host"
              onClick={() => openSelectedHosts('workspace')}
            >
              Workspace
            </button>
            <button
              title="Save these hosts as a collection you can reopen later"
              onClick={(e) => {
                e.stopPropagation()
                const picked = [...selectedHostIds]
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    ...collections.map((c) => ({
                      label: `Add to “${c.name}”`,
                      onSelect: async () => {
                        await addToCollection(c.id, picked)
                        clearHostSelection()
                      }
                    })),
                    {
                      label: 'New collection…',
                      separated: collections.length > 0,
                      onSelect: () => setCollecting(picked)
                    }
                  ]
                })
              }}
            >
              Collect
            </button>
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button title={keyHint('Snippets (⌘K)')} onClick={onOpenSnippets}>
          Snippets
        </button>
        <span style={{ flex: 1 }} />
        <button className="icon-button" title={keyHint('Shortcuts and features (⌘/)')} onClick={onOpenHelp}>
          ?
        </button>
        <button className="icon-button" title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
        <button className="icon-button" title={keyHint('Lock vault (⌘L)')} onClick={() => lockVault()}>
          🔒
        </button>
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

      {collecting && (
        <CollectionDialog
          hostIds={collecting}
          onClose={() => {
            setCollecting(null)
            clearHostSelection()
          }}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {groupDialog && (
        <GroupDialog
          initial={groupDialog.group}
          parentId={groupDialog.parentId}
          onClose={() => setGroupDialog(null)}
        />
      )}
    </div>
  )
}
