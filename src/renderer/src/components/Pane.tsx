import type { PaneNode } from '../state/store'
import { useStore } from '../state/store'
import TerminalHost from './TerminalHost'
import SftpPanel from './SftpPanel'

export default function Pane({
  tabId,
  node
}: {
  tabId: string
  node: Extract<PaneNode, { type: 'leaf' }>
}): JSX.Element {
  const activePaneId = useStore((s) => s.tabs.find((t) => t.id === tabId)?.activePaneId)
  const isActiveTab = useStore((s) => s.activeTabId === tabId)
  const setActivePane = useStore((s) => s.setActivePane)
  const setPaneConnection = useStore((s) => s.setPaneConnection)
  const splitPane = useStore((s) => s.splitPane)
  const toggleSftp = useStore((s) => s.toggleSftp)

  const isActive = isActiveTab && activePaneId === node.id

  return (
    <div className={`pane ${isActive ? 'active' : ''}`}>
      <div className="pane-toolbar">
        <span>{node.title}</span>
        <div className="actions">
          <button title="Split right" onClick={() => splitPane(tabId, node.id, 'row')}>
            ⬓
          </button>
          <button title="Split down" onClick={() => splitPane(tabId, node.id, 'col')}>
            ⬒
          </button>
          <button title="Toggle SFTP browser" onClick={() => toggleSftp(tabId, node.id)}>
            SFTP
          </button>
        </div>
      </div>
      <div className="pane-body">
        <TerminalHost
          target={node.target}
          connectionId={node.connectionId}
          active={isActive}
          onFocus={() => setActivePane(tabId, node.id)}
          onConnected={(connectionId) => setPaneConnection(tabId, node.id, connectionId)}
        />
        {node.sftpOpen && <SftpPanel connectionId={node.connectionId} />}
      </div>
    </div>
  )
}
