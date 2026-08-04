import { useStore } from '../state/store'
import SplitContainer from './SplitContainer'

export default function Workspace(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)

  return (
    <div className="workspace">
      <div className="tab-bar">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeTabId ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            <span>{t.title}</span>
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
      </div>
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
