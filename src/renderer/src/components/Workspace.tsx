import { useStore, collectLeaves } from '../state/store'
import { DRAG_MIME } from '../state/dnd'
import SplitContainer from './SplitContainer'

export default function Workspace(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const toggleBroadcast = useStore((s) => s.toggleBroadcast)
  const broadcast = useStore((s) => s.broadcast)
  const setAllPanesBroadcast = useStore((s) => s.setAllPanesBroadcast)

  const allLeaves = tabs.flatMap((t) => collectLeaves(t.root))
  const includedCount = allLeaves.filter((l) => l.broadcastEnabled).length

  return (
    <div className="workspace">
      <div className="tab-bar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'active' : ''}`}
            draggable
            title="Drag onto a pane to view side by side"
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: 'tab', id: t.id }))
              e.dataTransfer.effectAllowed = 'copyMove'
            }}
            onClick={() => setActiveTab(t.id)}
          >
            {(() => {
              const colour = collectLeaves(t.root).find((l) => l.color)?.color
              return colour ? <span className="tab-colour" style={{ background: colour }} /> : null
            })()}
            {t.hasActivity && t.id !== activeTabId && (
              <span className="activity-dot" title="New output since you last looked" />
            )}
            <span>{t.title}</span>
            {broadcast && collectLeaves(t.root).some((l) => l.broadcastEnabled) && (
              <span className="tab-badge">⇉</span>
            )}
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
            >
              ✕
            </span>
          </div>
        ))}
        {tabs.length > 0 && (
          <button
            className={`broadcast-toggle ${broadcast ? 'on' : ''}`}
            title="Mirror typing to every open pane, in every tab"
            onClick={() => toggleBroadcast()}
          >
            ⇉ Broadcast
          </button>
        )}
      </div>
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
      {tabs.length === 0 && (
        <div className="empty-workspace">Select a session on the left, or quick-connect above.</div>
      )}
      {tabs.map((t) => (
        <div key={t.id} className="tab-panel" style={{ display: t.id === activeTabId ? 'flex' : 'none' }}>
          <SplitContainer tabId={t.id} node={t.root} />
        </div>
      ))}
    </div>
  )
}
