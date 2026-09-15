import { logoffSequence } from '../../../shared/rdpLogoff'
import { protocolOf, type Protocol } from '../../../shared/protocols'
import { collectLeaves } from './paneTree'
import { findHost } from './hosts'
import type { AppState, Workspace } from './slices/types'

export interface DesktopPane {
  tabId: string
  paneId: string
  /** The live session, when there is one to sign out of. */
  desktopId?: string
}

/**
 * Every desktop pane in a workspace, connected or not.
 *
 * Asked of the host rather than of the pane, as the pane itself does: a pane
 * that failed to connect has no desktop id and is still a desktop to close.
 */
export function desktopPanesOf(
  workspace: Workspace,
  protocolFor: (sessionId: string) => Protocol
): DesktopPane[] {
  return workspace.tabs.flatMap((tab) =>
    collectLeaves(tab.root)
      .filter(
        (leaf) => leaf.target.kind === 'session' && protocolFor(leaf.target.sessionId) === 'rdp'
      )
      .map((leaf) => ({ tabId: tab.id, paneId: leaf.id, desktopId: leaf.desktopId }))
  )
}

export function protocolIn(state: AppState): (sessionId: string) => Protocol {
  return (sessionId) => protocolOf(findHost(state, sessionId)?.host)
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function signOut(desktopId: string): Promise<void> {
  for (const step of logoffSequence()) {
    if ('wait' in step) await pause(step.wait)
    else window.td.rdp.desktopSend(desktopId, step.send)
  }
}

/**
 * Signs every live desktop in a workspace out of Windows, then closes all of
 * its desktop panes. Terminals in the same workspace are left alone.
 *
 * The sessions are asked together and the panes close together, once the last
 * of them has had its keys delivered.
 */
export async function signOutWorkspace(
  getState: () => AppState,
  workspaceId: string
): Promise<void> {
  const workspace = getState().workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return
  const panes = desktopPanesOf(workspace, protocolIn(getState()))

  await Promise.all(panes.flatMap((p) => (p.desktopId ? [signOut(p.desktopId)] : [])))

  // Closed by id against the store as it is now: a pane may have been closed
  // by hand, or its tab moved, while the keys were on their way.
  for (const pane of panes) {
    const tab = getState()
      .workspaces.flatMap((w) => w.tabs)
      .find((t) => t.id === pane.tabId)
    if (tab && collectLeaves(tab.root).some((l) => l.id === pane.paneId))
      getState().closePane(pane.tabId, pane.paneId)
  }
}
