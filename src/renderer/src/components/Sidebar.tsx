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

  const [editingSession, setEditingSession] = useState<SessionProfile | undefined | 'new'>(undefined)
  const [showQuickConnect, setShowQuickConnect] = useState(false)

  function connect(session: SessionProfile): void {
    openTab(session.name, { kind: 'session', sessionId: session.id })
  }

  async function addGroup(parentId: string | null): Promise<void> {
    const name = prompt('Group name')
    if (!name) return
    await upsertGroup({ id: nanoid(), name, parentId })
  }

  const rootSessions = sessions.filter((s) => s.groupId === null)

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
      </div>
      <div className="sidebar-tree">
        {groups.map((g) => (
          <div className="tree-group" key={g.id}>
            <div className="tree-item">
              <span className="tree-group-title name">📁 {g.name}</span>
              <div className="actions">
                <button onClick={() => removeGroup(g.id)}>✕</button>
              </div>
            </div>
            {sessions
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
