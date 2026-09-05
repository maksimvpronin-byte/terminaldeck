import AiPanel from './AiPanel'
import { useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type { PaneNode, PaneTarget } from '../state/store'
import {
  useStore,
  collectBroadcastTargets,
  collectLeaves,
  activeTab,
  allTabs,
  findTab
} from '../state/store'
import { DRAG_MIME, edgeFromPoint, edgeToSplit, type DragItem, type DropEdge } from '../state/dnd'
import TerminalHost from './TerminalHost'
import GraphicalHost, { toggleFullscreen } from './GraphicalHost'
import SftpPanel from './SftpPanel'
import TunnelsPanel from './TunnelsPanel'
import MonitorBar from './MonitorBar'
import { protocolOf, traitsOf } from '../../../shared/protocols'
import { SplitRightIcon, SplitDownIcon, CloseIcon, DetachIcon } from './icons'
import Hint from './Hint'
import { keyHint } from '../state/keys'
import { useT } from '../i18n'

export default function Pane({
  tabId,
  node
}: {
  tabId: string
  node: Extract<PaneNode, { type: 'leaf' }>
}): JSX.Element {
  const t = useT()
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

  // Read from the profile rather than copied onto the leaf: changing a host's
  // protocol should take effect in its open panes, not only in the next one.
  // Quick-connect has no profile and is SSH by definition.
  const sessionId = node.target.kind === 'session' ? node.target.sessionId : null
  /** A stored account chosen for this pane, in place of the host's own login. */
  const credentialId = node.target.kind === 'session' ? node.target.credentialId : undefined
  const protocol = useStore((s) =>
    sessionId ? protocolOf(s.sessions.find((x) => x.id === sessionId)) : 'ssh'
  )
  const host = useStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.host : undefined
  )
  // Unset means the protocol's own default, which GraphicalHost fills in. The
  // SSH inheritance chain is not consulted: it resolves to 22.
  const port = useStore((s) =>
    sessionId ? s.sessions.find((x) => x.id === sessionId)?.port : undefined
  )
  const traits = traitsOf(protocol)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null)
  /**
   * What size a desktop was asked for and what the server gave back.
   *
   * Kept here so it can be read from a mark in this toolbar rather than from a
   * native tooltip over the session itself — see `onMeasured` in GraphicalHost
   * for what that cost. Empty for a terminal, which has no such thing.
   */
  const [measured, setMeasured] = useState('')
  const [aiOpen, setAiOpen] = useState(false)

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
        {/* Name and mark in one element, because the toolbar lays its children
            out with space-between: a third child would be pushed to the middle
            of the strip rather than sitting beside the name it belongs to. */}
        <span className="pane-name">
          {node.title}
          {measured && (
            <Hint>
              {t('The size this desktop asked for, and what the server gave back.')} {measured}
            </Hint>
          )}
        </span>
        <div className="actions">
          {broadcast && traits.broadcast && (
            <label className="broadcast-check" title={t('Include this terminal in broadcast')}>
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
            title={keyHint(t('Split right (⌘D)'))}
            onClick={() => splitPane(tabId, node.id, 'row')}
          >
            <SplitRightIcon />
          </button>
          <button
            className="icon-button"
            title={keyHint(t('Split down (⌘⇧D)'))}
            onClick={() => splitPane(tabId, node.id, 'col')}
          >
            <SplitDownIcon />
          </button>
          {/* Hidden rather than disabled: these ride on an SSH connection, and a
              desktop session will never have one to offer them. */}
          {traits.files && (
            <button title={t('Toggle SFTP browser')} onClick={() => toggleSftp(tabId, node.id)}>
              {t('SFTP')}
            </button>
          )}
          {traits.tunnels && (
            <button
              title={t('Toggle port forwarding')}
              onClick={() => toggleTunnels(tabId, node.id)}
            >
              {t('Tunnels')}
            </button>
          )}
          {traits.textual && (
            <button
              disabled={!node.connectionId}
              className={aiOpen ? 'active' : ''}
              title={t('AI assistant')}
              onClick={() => setAiOpen(!aiOpen)}
            >
              {t('AI')}
            </button>
          )}
          {traits.monitor && (
            <button
              className={node.monitorOpen ? 'active' : ''}
              disabled={!node.connectionId}
              title={t('Toggle remote monitoring')}
              onClick={() => toggleMonitor(tabId, node.id)}
            >
              {t('Monitor')}
            </button>
          )}
          {/* Only a desktop has anything to gain: full screen is where a remote
              machine's Alt+Tab can reach it, and a terminal never wanted the
              key in the first place. */}
          {!traits.textual && (
            <button
              className="icon-button"
              title={t('Full screen (F11) — hold Escape to leave')}
              onClick={() => rootRef.current && toggleFullscreen(rootRef.current)}
            >
              ⛶
            </button>
          )}
          {isSplit && (
            <button
              className="icon-button"
              title={t('Move this pane to its own tab')}
              onClick={() => detachPane(tabId, node.id)}
            >
              <DetachIcon />
            </button>
          )}
          <button
            className="icon-button"
            title={keyHint(t('Close pane (⌘W)'))}
            onClick={() => closePane(tabId, node.id)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      <div className="pane-body">
        {traits.textual ? (
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
              const all = allTabs(state).flatMap((tab) => collectBroadcastTargets(tab.root))
              return all.length > 0 ? all : [own]
            }}
          />
        ) : (
          <GraphicalHost
            protocol={protocol}
            host={host}
            port={port}
            sessionId={sessionId ?? undefined}
            credentialId={credentialId}
            onMeasured={setMeasured}
            paneVisible={isActiveTab}
          />
        )}
        {traits.textual && node.connectionId && (
          <AiPanel
            key={node.connectionId}
            connectionId={node.connectionId}
            title={node.title}
            visible={aiOpen && isActiveTab}
            onClose={() => setAiOpen(false)}
          />
        )}
        {traits.files && node.sftpOpen && <SftpPanel connectionId={node.connectionId} />}
        {traits.tunnels && node.tunnelsOpen && (
          <TunnelsPanel
            connectionId={node.connectionId}
            sessionId={node.target.kind === 'session' ? node.target.sessionId : undefined}
          />
        )}
      </div>
      {/* Below the body, not inside it: the strip is about the host, so it
          spans the terminal and any panel open beside it. */}
      {traits.monitor && node.monitorOpen && <MonitorBar connectionId={node.connectionId} />}
    </div>
  )
}
