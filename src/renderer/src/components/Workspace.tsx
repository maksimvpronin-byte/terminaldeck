import { useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import {
  useStore,
  collectLeaves,
  activeWorkspace as selectActiveWorkspace,
  allTabs as selectAllTabs,
  workspaceHasActivity
} from '../state/store'
import { sessionIdsOf } from '../state/workspaces'
import { DRAG_MIME, type DragItem } from '../state/dnd'
import SplitContainer from './SplitContainer'
import ContextMenu, { type MenuItem } from './ContextMenu'
import CollectionDialog from './CollectionDialog'
import { CloseIcon } from './icons'
import { useT } from '../i18n'

export default function Workspace(): JSX.Element {
  const t = useT()
  const workspaces = useStore((s) => s.workspaces)
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId)
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace)
  const openWorkspace = useStore((s) => s.openWorkspace)
  const closeWorkspace = useStore((s) => s.closeWorkspace)
  const renameWorkspace = useStore((s) => s.renameWorkspace)
  const moveTabToWorkspace = useStore((s) => s.moveTabToWorkspace)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const toggleBroadcast = useStore((s) => s.toggleBroadcast)
  const broadcast = useStore((s) => s.broadcast)
  const setAllPanesBroadcast = useStore((s) => s.setAllPanesBroadcast)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  /** Workspace being hovered by a dragged tab, for the drop outline. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** Workspace being saved as a collection, so it can be reopened after closing. */
  const [saving, setSaving] = useState<string | null>(null)
  const savingWorkspace = workspaces.find((w) => w.id === saving)

  const view = { workspaces, activeWorkspaceId }
  const current = selectActiveWorkspace(view)
  const everyTab = selectAllTabs(view)
  const allLeaves = everyTab.flatMap((t) => collectLeaves(t.root))
  const includedCount = allLeaves.filter((l) => l.broadcastEnabled).length

  function startRename(id: string, title: string): void {
    setRenaming(id)
    setDraftTitle(title)
  }

  function commitRename(): void {
    if (renaming) renameWorkspace(renaming, draftTitle)
    setRenaming(null)
  }

  /**
   * Closing a workspace takes every terminal in it down at once, so anything
   * beyond a single tab asks first. Compared against `false` on purpose: if the
   * dialog were ever unavailable the close still goes through, rather than
   * becoming impossible.
   */
  function requestCloseWorkspace(id: string, title: string, tabCount: number): void {
    if (
      tabCount > 1 &&
      window.confirm(`Close “${title}” and disconnect its ${tabCount} terminals?`) === false
    ) {
      return
    }
    closeWorkspace(id)
  }

  function onWorkspaceDrop(e: ReactDragEvent, workspaceId: string): void {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw) return
    const item = JSON.parse(raw) as DragItem
    if (item.kind === 'tab') moveTabToWorkspace(item.id, workspaceId)
  }

  return (
    <div className="workspace">
      <div className="workspace-bar">
        {workspaces.map((w) => {
          const isActive = w.id === activeWorkspaceId
          return (
            <div
              key={w.id}
              className={`workspace-chip ${isActive ? 'active' : ''} ${
                dropTarget === w.id ? 'drop' : ''
              }`}
              title={t("Double-click to rename; right-click to save it; drop a tab here to move it")}
              onClick={() => setActiveWorkspace(w.id)}
              onDoubleClick={() => startRename(w.id, w.title)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    {
                      label: t('Save as collection…'),
                      disabled: sessionIdsOf(w).length === 0,
                      onSelect: () => setSaving(w.id)
                    },
                    { label: t('Rename…'), onSelect: () => startRename(w.id, w.title) },
                    {
                      label: t('Close workspace'),
                      danger: true,
                      separated: true,
                      onSelect: () => requestCloseWorkspace(w.id, w.title, w.tabs.length)
                    }
                  ]
                })
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_MIME)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropTarget(w.id)
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === w.id ? null : cur))}
              onDrop={(e) => onWorkspaceDrop(e, w.id)}
            >
              {w.color && <span className="tab-colour" style={{ background: w.color }} />}
              {!isActive && workspaceHasActivity(w) && (
                <span className="activity-dot" title={t("New output in this workspace")} />
              )}
              {renaming === w.id ? (
                <input
                  autoFocus
                  className="workspace-rename"
                  value={draftTitle}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <span className="workspace-name">{w.title}</span>
              )}
              <span className="workspace-count">{w.tabs.length}</span>
              <span
                className="close"
                title={t("Close this workspace and everything in it")}
                onClick={(e) => {
                  e.stopPropagation()
                  requestCloseWorkspace(w.id, w.title, w.tabs.length)
                }}
              >
                <CloseIcon />
              </span>
            </div>
          )
        })}
        <button
          className="workspace-add"
          title={t("New workspace")}
          onClick={() => openWorkspace()}
        >
          +
        </button>
        <span className="workspace-bar-spacer" />
        {allLeaves.length > 0 && (
          <button
            className={`broadcast-toggle ${broadcast ? 'on' : ''}`}
            title={t("Mirror typing to every open pane, in every workspace")}
            onClick={() => toggleBroadcast()}
          >
            ⇉ Broadcast
          </button>
        )}
      </div>

      {current && current.tabs.length > 0 && (
        <div className="tab-bar">
          {current.tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === current.activeTabId ? 'active' : ''}`}
              draggable
              title={t("Drag onto a pane to view side by side, or onto a workspace to move it")}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'tab', id: tab.id }))
                e.dataTransfer.effectAllowed = 'copyMove'
              }}
              onClick={() => setActiveTab(tab.id)}
            >
              {(() => {
                const colour = collectLeaves(tab.root).find((l) => l.color)?.color
                return colour ? (
                  <span className="tab-colour" style={{ background: colour }} />
                ) : null
              })()}
              {tab.hasActivity && tab.id !== current.activeTabId && (
                <span className="activity-dot" title={t("New output since you last looked")} />
              )}
              <span>{tab.title}</span>
              {broadcast && collectLeaves(tab.root).some((l) => l.broadcastEnabled) && (
                <span className="tab-badge">⇉</span>
              )}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ✕
              </span>
            </div>
          ))}
        </div>
      )}

      {broadcast && (
        <div className="broadcast-banner">
          <span>
            Broadcast on — typing goes to{' '}
            <strong>
              {includedCount} of {allLeaves.length}
            </strong>{' '}
            terminals. Use the ⇉ checkbox in a pane to include or exclude it.
          </span>
          <span className="banner-actions">
            <button onClick={() => setAllPanesBroadcast(true)}>All</button>
            <button onClick={() => setAllPanesBroadcast(false)}>None</button>
          </span>
        </div>
      )}

      {(!current || current.tabs.length === 0) && (
        <div className="empty-workspace">
          {workspaces.length === 0
            ? t('Select a session on the left, or quick-connect above.')
            : `“${current?.title}” is empty — open a host on the left to fill it.`}
        </div>
      )}

      {/* Every tab in every workspace is rendered here, and only shown when its
          workspace and tab are both current. Keeping them all mounted is what
          holds the SSH sessions open in the background — and what lets a tab be
          dragged to another workspace without its terminal being torn down. */}
      {/* Tab ids are unique across workspaces, so matching the current
          workspace's active tab picks exactly one panel to show. */}
      {everyTab.map((t) => (
        <div
          key={t.id}
          className="tab-panel"
          style={{ display: current?.activeTabId === t.id ? 'flex' : 'none' }}
        >
          <SplitContainer tabId={t.id} node={t.root} />
        </div>
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
      {savingWorkspace && (
        <CollectionDialog
          hostIds={sessionIdsOf(savingWorkspace)}
          defaultName={savingWorkspace.title}
          defaultColor={savingWorkspace.color}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  )
}
