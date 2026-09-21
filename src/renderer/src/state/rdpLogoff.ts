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
 * How long a desktop has to confirm it signed out, counted from the keys.
 *
 * Signing out is confirmed by the host ending the session with a sign-out as
 * its reason, which closes the pane on its own (see `endedBySignOut`). A busy
 * host with a long list of programs to close can take a while over it.
 */
export const SIGN_OUT_CONFIRM_WAIT = 20_000
const CONFIRM_POLL = 250

/** Whether the pane is still open, looked up as the store is now. */
function isOpen(getState: () => AppState, pane: DesktopPane): boolean {
  const tab = getState()
    .workspaces.flatMap((w) => w.tabs)
    .find((t) => t.id === pane.tabId)
  return Boolean(tab && collectLeaves(tab.root).some((l) => l.id === pane.paneId))
}

function close(getState: () => AppState, pane: DesktopPane): void {
  // By id against the store as it is now: a pane may have been closed by hand,
  // or its tab moved, while the keys were on their way.
  if (isOpen(getState, pane)) getState().closePane(pane.tabId, pane.paneId)
}

/**
 * Signs every live desktop in a workspace out of Windows. Terminals in the same
 * workspace are left alone.
 *
 * A desktop's pane closes when its host says it signed out, not when the keys
 * have been sent. The keys are a person's way of asking and nothing more: a
 * locked session types the word into its password box, a policy can take the
 * Run dialog away, a slow desktop can miss them. Closing every pane on a timer
 * reported all of those as signed out, and left the sessions running on their
 * hosts with nothing on this side to show it.
 *
 * So what has not confirmed within the wait stays open, and `closeUnconfirmed`
 * is asked — with how many — whether to close them anyway. A pane that never
 * connected has nothing to sign out of, and closes at once.
 */
export async function signOutWorkspace(
  getState: () => AppState,
  workspaceId: string,
  closeUnconfirmed: (count: number) => boolean,
  wait = SIGN_OUT_CONFIRM_WAIT
): Promise<void> {
  const workspace = getState().workspaces.find((w) => w.id === workspaceId)
  if (!workspace) return
  const panes = desktopPanesOf(workspace, protocolIn(getState()))
  const live = panes.filter((p) => p.desktopId)

  for (const pane of panes) if (!pane.desktopId) close(getState, pane)

  await Promise.all(live.map((p) => signOut(p.desktopId!)))

  for (let waited = 0; waited < wait; waited += CONFIRM_POLL) {
    if (!live.some((p) => isOpen(getState, p))) return
    await pause(CONFIRM_POLL)
  }

  const unconfirmed = live.filter((p) => isOpen(getState, p))
  if (unconfirmed.length === 0 || !closeUnconfirmed(unconfirmed.length)) return
  for (const pane of unconfirmed) close(getState, pane)
}
