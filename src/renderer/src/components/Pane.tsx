import type { PaneNode } from '../state/store'
import { useStore, collectBroadcastTargets } from '../state/store'
import TerminalHost from './TerminalHost'
import SftpPanel from './SftpPanel'
import TunnelsPanel from './TunnelsPanel'

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
  const closePane = useStore((s) => s.closePane)
  const toggleSftp = useStore((s) => s.toggleSftp)
  const toggleTunnels = useStore((s) => s.toggleTunnels)
  const broadcast = useStore((s) => s.broadcast)
  const togglePaneBroadcast = useStore((s) => s.togglePaneBroadcast)

  const isActive = isActiveTab && activePaneId === node.id

  return (
    <div className={`pane ${isActive ? 'active' : ''}`}>
      <div className={`pane-toolbar ${broadcast && node.broadcastEnabled ? 'broadcasting' : ''}`}>
        <span>{node.title}</span>
        <div className="actions">
          {broadcast && (
            <label className="broadcast-check" title="Include this terminal in broadcast">
              <input
                type="checkbox"
                checked={node.broadcastEnabled}
                onChange={() => togglePaneBroadcast(tabId, node.id)}
              />
              ⇉
            </label>
          )}
          <button title="Split right" onClick={() => splitPane(tabId, node.id, 'row')}>
            ⬓
          </button>
          <button title="Split down" onClick={() => splitPane(tabId, node.id, 'col')}>
            ⬒
          </button>
          <button title="Toggle SFTP browser" onClick={() => toggleSftp(tabId, node.id)}>
            SFTP
          </button>
          <button title="Toggle port forwarding" onClick={() => toggleTunnels(tabId, node.id)}>
            Tunnels
          </button>
          <button title="Close pane (⌘W)" onClick={() => closePane(tabId, node.id)}>
            ✕
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
          resolveWriteTargets={(own) => {
            const state = useStore.getState()
            // A terminal excluded from broadcast keeps its own input to itself.
            if (!state.broadcast || !node.broadcastEnabled) return [own]
            const all = state.tabs.flatMap((t) => collectBroadcastTargets(t.root))
            return all.length > 0 ? all : [own]
          }}
        />
        {node.sftpOpen && <SftpPanel connectionId={node.connectionId} />}
        {node.tunnelsOpen && (
          <TunnelsPanel
            connectionId={node.connectionId}
            sessionId={node.target.kind === 'session' ? node.target.sessionId : undefined}
          />
        )}
      </div>
    </div>
  )
}
