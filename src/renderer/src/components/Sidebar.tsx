import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { SessionProfile } from '../../../shared/types'
import { useStore } from '../state/store'
import SessionDialog from './SessionDialog'
import QuickConnectDialog from './QuickConnectDialog'

export default function Sidebar(): JSX.Element {
  const groups = useStore((s) => s.groups)
  const sessions = useStore((s) => s.sessions)
  const upsertGroup = useStore((s) => s.upsertGroup)
  const removeGroup = useStore((s) => s.removeGroup)
  const removeSession = useStore((s) => s.removeSession)
  const openTab = useStore((s) => s.openTab)
  const lockVault = useStore((s) => s.lockVault)

  const [editingSession, setEditingSession] = useState<SessionProfile | undefined | 'new'>(undefined)
  const [showQuickConnect, setShowQuickConnect] = useState(false)
  const [query, setQuery] = useState('')

  function connect(session: SessionProfile): void {
    openTab(session.name, { kind: 'session', sessionId: session.id })
  }

  async function addGroup(parentId: string | null): Promise<void> {
    const name = prompt('Group name')
    if (!name) return
    await upsertGroup({ id: nanoid(), name, parentId })
  }

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? sessions.filter((s) =>
        [s.name, s.host, s.username, ...s.tags].some((f) => f.toLowerCase().includes(needle))
      )
    : sessions

  const rootSessions = visible.filter((s) => s.groupId === null)
  // While filtering, hide groups that no longer contain a match.
  const visibleGroups = needle
    ? groups.filter((g) => visible.some((s) => s.groupId === g.id))
    : groups

  return (
    <div className="sidebar">
      <div className="titlebar-spacer" />
      <div className="sidebar-header">
        <button className="primary" style={{ flex: 1 }} onClick={() => setEditingSession('new')}>
          + Session
        </button>
        <button onClick={() => addGroup(null)}>+ Group</button>
      </div>
      <div className="sidebar-header" style={{ borderTop: 'none' }}>
        <button style={{ flex: 1 }} onClick={() => setShowQuickConnect(true)}>
          Quick connect…
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
      <div className="sidebar-tree">
        {visibleGroups.map((g) => (
          <div className="tree-group" key={g.id}>
            <div className="tree-item">
              <span className="tree-group-title name">📁 {g.name}</span>
              <div className="actions">
                <button onClick={() => removeGroup(g.id)}>✕</button>
              </div>
            </div>
            {visible
              .filter((s) => s.groupId === g.id)
              .map((s) => (
                <div className="tree-item" key={s.id} style={{ paddingLeft: 18 }} onDoubleClick={() => connect(s)}>
                  <span className="name" onClick={() => connect(s)}>
                    🖥 {s.name}
                  </span>
                  <div className="actions">
                    <button onClick={() => setEditingSession(s)}>Edit</button>
                    <button onClick={() => removeSession(s.id)}>✕</button>
                  </div>
                </div>
              ))}
          </div>
        ))}

        {rootSessions.length > 0 && (
          <div className="tree-group">
            <div className="tree-group-title">Sessions</div>
            {rootSessions.map((s) => (
              <div className="tree-item" key={s.id} onDoubleClick={() => connect(s)}>
                <span className="name" onClick={() => connect(s)}>
                  🖥 {s.name}
                </span>
                <div className="actions">
                  <button onClick={() => setEditingSession(s)}>Edit</button>
                  <button onClick={() => removeSession(s.id)}>✕</button>
                </div>
              </div>
            ))}
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
    </div>
  )
}
