import { useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { PaneNode, PaneTarget } from '../state/store'
import { useStore, collectBroadcastTargets, collectLeaves, activeTab, allTabs, findTab } from '../state/store'
import { DRAG_MIME, edgeFromPoint, edgeToSplit, type DragItem, type DropEdge } from '../state/dnd'
import TerminalHost from './TerminalHost'
import SftpPanel from './SftpPanel'
import TunnelsPanel from './TunnelsPanel'
import MonitorBar from './MonitorBar'
import { SplitRightIcon, SplitDownIcon, CloseIcon, DetachIcon } from './icons'
import { keyHint } from '../state/keys'

export default function Pane({
  tabId,
  node
}: {
  tabId: string
  node: Extract<PaneNode, { type: 'leaf' }>
}): JSX.Element {
  const activePaneId = useStore((s) => findTab(s, tabId)?.activePaneId)
  // On screen only when this tab is the current one of the current workspace.
  const isActiveTab = useStore((s) => activeTab(s)?.id === tabId)
  const setActivePane = useStore((s) => s.setActivePane)
  const markActivity = useStore((s) => s.markActivity)
  const setPaneConnection = useStore((s) => s.setPaneConnection)
  const splitPane = useStore((s) => s.splitPane)
  const closePane = useStore((s) => s.closePane)
  const detachPane = useStore((s) => s.detachPane)
  const isSplit = useStore((s) => findTab(s, tabId)?.root.type === 'split')
  const toggleSftp = useStore((s) => s.toggleSftp)
  const toggleTunnels = useStore((s) => s.toggleTunnels)
  const toggleMonitor = useStore((s) => s.toggleMonitor)
  const broadcast = useStore((s) => s.broadcast)
  const togglePaneBroadcast = useStore((s) => s.togglePaneBroadcast)

  const splitPaneWith = useStore((s) => s.splitPaneWith)
  const closeTab = useStore((s) => s.closeTab)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null)

  const isActive = isActiveTab && activePaneId === node.id

  function onDragOver(e: ReactDragEvent): void {
    if (!e.dataTransfer.types.includes(DRAG_MIME) || !rootRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropEdge(edgeFromPoint(rootRef.current.getBoundingClientRect(), e.clientX, e.clientY))
  }

  function onDrop(e: ReactDragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const edge = dropEdge
    setDropEdge(null)
    const raw = e.dataTransfer.getData(DRAG_MIME)
    if (!raw || !edge) return
    const item = JSON.parse(raw) as DragItem

    let title: string
    let target: PaneTarget
    if (item.kind === 'session') {
      const session = useStore.getState().sessions.find((s) => s.id === item.id)
      if (!session) return
      title = session.name
      target = { kind: 'session', sessionId: session.id }
    } else if (item.kind === 'tab') {
      const sourceTab = findTab(useStore.getState(), item.id)
      if (!sourceTab || sourceTab.id === tabId) return
      const leaf = collectLeaves(sourceTab.root)[0]
      if (!leaf) return
      title = leaf.title
      target = leaf.target
    } else {
      return // groups have no terminal to open
    }

    const { dir, position } = edgeToSplit(edge)
    splitPaneWith(tabId, node.id, dir, position, title, target)
    // A dragged tab moves here, so retire the original.
    if (item.kind === 'tab') closeTab(item.id)
  }

  return (
    <div
      className={`pane ${isActive ? 'active' : ''}`}
      ref={rootRef}
      onDragOver={onDragOver}
      onDragLeave={() => setDropEdge(null)}
      onDrop={onDrop}
    >
      {dropEdge && <div className={`pane-drop-hint ${dropEdge}`} />}
      <div
        className={`pane-toolbar ${broadcast && node.broadcastEnabled ? 'broadcasting' : ''}`}
        style={node.color ? { borderLeft: `3px solid ${node.color}` } : undefined}
      >
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
          <button
            className="icon-button"
            title={keyHint('Split right (⌘D)')}
            onClick={() => splitPane(tabId, node.id, 'row')}
          >
            <SplitRightIcon />
          </button>
          <button
            className="icon-button"
            title={keyHint('Split down (⌘⇧D)')}
            onClick={() => splitPane(tabId, node.id, 'col')}
          >
            <SplitDownIcon />
          </button>
          <button title="Toggle SFTP browser" onClick={() => toggleSftp(tabId, node.id)}>
            SFTP
          </button>
          <button title="Toggle port forwarding" onClick={() => toggleTunnels(tabId, node.id)}>
            Tunnels
          </button>
          <button
            className={node.monitorOpen ? 'active' : ''}
            disabled={!node.connectionId}
            title="Toggle remote monitoring"
            onClick={() => toggleMonitor(tabId, node.id)}
          >
            Monitor
          </button>
          {isSplit && (
            <button
              className="icon-button"
              title="Move this pane to its own tab"
              onClick={() => detachPane(tabId, node.id)}
            >
              <DetachIcon />
            </button>
          )}
          <button
            className="icon-button"
            title={keyHint('Close pane (⌘W)')}
            onClick={() => closePane(tabId, node.id)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        <TerminalHost
          target={node.target}
          viaCollectionId={node.viaCollectionId}
          connectionId={node.connectionId}
          active={isActive}
          restored={node.restored}
          onFocus={() => setActivePane(tabId, node.id)}
          onOutput={() => markActivity(tabId)}
          onConnected={(connectionId) => setPaneConnection(tabId, node.id, connectionId)}
          resolveWriteTargets={(own) => {
            const state = useStore.getState()
            // A terminal excluded from broadcast keeps its own input to itself.
            if (!state.broadcast || !node.broadcastEnabled) return [own]
            const all = allTabs(state).flatMap((t) => collectBroadcastTargets(t.root))
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
      {/* Below the body, not inside it: the strip is about the host, so it
          spans the terminal and any panel open beside it. */}
      {node.monitorOpen && <MonitorBar connectionId={node.connectionId} />}
    </div>
  )
}
