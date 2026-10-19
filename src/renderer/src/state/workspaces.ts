import { collectLeaves, type PaneNode, type PaneTarget } from './paneTree'
import type { AppState, Workspace, WorkspaceTab } from './slices/types'
import { findHost } from './hosts'
import { protocolOf } from '../../../shared/protocols'
import { authChain, defaultCredential } from '../../../shared/authResolution'
import { resolveRdp } from '../../../shared/rdpResolution'

/** Shape shared by the store and the persisted layout, so both can be walked. */
interface HasWorkspaces {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/**
 * Every tab in every workspace — for anything that scans the whole app.
 * Takes only the list, so callers with a bare `workspaces` need not invent an
 * active id they have no use for.
 */
export function allTabs(state: Pick<HasWorkspaces, 'workspaces'>): WorkspaceTab[] {
  return state.workspaces.flatMap((w) => w.tabs)
}

/** Every pane tree in the app, for broadcast and connected-host marks. */
export function allRoots(state: Pick<HasWorkspaces, 'workspaces'>): PaneNode[] {
  return allTabs(state).map((t) => t.root)
}

export function activeWorkspace(state: HasWorkspaces): Workspace | undefined {
  return state.workspaces.find((w) => w.id === state.activeWorkspaceId)
}

/** The tab the user is looking at: the current workspace's current tab. */
export function activeTab(state: HasWorkspaces): WorkspaceTab | undefined {
  const workspace = activeWorkspace(state)
  if (!workspace) return undefined
  return workspace.tabs.find((t) => t.id === workspace.activeTabId)
}

export function findTab(state: HasWorkspaces, tabId: string): WorkspaceTab | undefined {
  for (const workspace of state.workspaces) {
    const tab = workspace.tabs.find((t) => t.id === tabId)
    if (tab) return tab
  }
  return undefined
}

export function workspaceOfTab(state: HasWorkspaces, tabId: string): Workspace | undefined {
  return state.workspaces.find((w) => w.tabs.some((t) => t.id === tabId))
}

/**
 * Rewrites one tab wherever it lives. Tab ids are unique across workspaces, so
 * the pane actions never need to be told which workspace they are working in.
 */
export function mapTab(
  workspaces: Workspace[],
  tabId: string,
  fn: (tab: WorkspaceTab) => WorkspaceTab
): Workspace[] {
  return workspaces.map((w) =>
    w.tabs.some((t) => t.id === tabId)
      ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? fn(t) : t)) }
      : w
  )
}

/**
 * The saved hosts a workspace currently holds, for storing it as a collection.
 * Quick connects are left out on purpose: their target carries a password in
 * the clear, and collections are stored unencrypted.
 */
export function sessionIdsOf(workspace: Workspace): string[] {
  const ids = workspace.tabs
    .flatMap((t) => collectLeaves(t.root))
    .filter((leaf) => leaf.target.kind === 'session')
    .map((leaf) => (leaf.target as { sessionId: string }).sessionId)
  return [...new Set(ids)]
}

/**
 * Where a saved host is open, as the pane to bring forward — or undefined when
 * it is open nowhere.
 *
 * Only live panes count, the same test the tree's "open now" mark uses: an idle
 * pane left from a restored layout is not the host being open, and jumping to
 * it would show a dead terminal instead of doing nothing.
 *
 * Open in several places, it steps through them in order, starting after the
 * pane being looked at — so clicking the host again finds the next copy rather
 * than staying put.
 */
export function nextOpenPaneOf(
  state: HasWorkspaces,
  sessionId: string
): { tabId: string; paneId: string } | undefined {
  const places = allTabs(state).flatMap((tab) =>
    collectLeaves(tab.root)
      .filter(
        (leaf) =>
          (leaf.connectionId ?? leaf.desktopId) &&
          leaf.target.kind === 'session' &&
          leaf.target.sessionId === sessionId
      )
      .map((leaf) => ({ tabId: tab.id, paneId: leaf.id }))
  )
  if (places.length === 0) return undefined
  const current = activeTab(state)
  const here = places.findIndex((p) => p.tabId === current?.id && p.paneId === current.activePaneId)
  if (here >= 0) return places[(here + 1) % places.length]
  // Not looking at it yet: one in the current tab beats one elsewhere.
  return places.find((p) => p.tabId === current?.id) ?? places[0]
}

/**
 * The pane a host should be brought forward in rather than opened again.
 *
 * The one in front if it is that host, else the first in the workspace in
 * front, else the first anywhere — "first" in the order the tabs are laid out,
 * so the same click lands in the same place every time. Any pane of the host
 * counts, live or not: one that has dropped is reconnected where it stands.
 *
 * `account` narrows it to panes signed in as that account (undefined being the
 * host's own login) — for a desktop, where another account is another Windows
 * session and may stand beside this one. Console mode narrows it the same way:
 * the administrative session is a different session too, and bringing forward
 * the ordinary pane for it would reconnect that pane without `/admin`.
 */
export function paneToReuse(
  state: HasWorkspaces,
  sessionId: string,
  account?: {
    credentialId: string | undefined
    admin?: boolean
    /** The account the host opens with when none is named: naming it is the same session. */
    defaultCredentialId?: string
    /** The host opens in console mode anyway: asking for it is the same session. */
    consoleSession?: boolean
  }
): { tabId: string; paneId: string } | undefined {
  // The account each side really signs in as. A live pane opened with none
  // named is the default it signed in with, whatever the default is now.
  const signsInAs = (leaf: ReturnType<typeof collectLeaves>[number]): string | undefined => {
    if (leaf.target.kind !== 'session') return undefined
    if (leaf.target.credentialId) return leaf.target.credentialId
    if (leaf.connectedAs !== undefined) return leaf.connectedAs ?? undefined
    return account?.defaultCredentialId
  }
  const fits = (leaf: ReturnType<typeof collectLeaves>[number]): boolean =>
    leaf.target.kind === 'session' &&
    leaf.target.sessionId === sessionId &&
    (!account ||
      (signsInAs(leaf) === (account.credentialId ?? account.defaultCredentialId) &&
        (leaf.target.admin === true || account.consoleSession === true) ===
          (account.admin === true || account.consoleSession === true)))
  const current = activeTab(state)
  const front = current && collectLeaves(current.root).find((l) => l.id === current.activePaneId)
  if (current && front && fits(front)) return { tabId: current.id, paneId: front.id }
  const tabs = [
    ...(activeWorkspace(state)?.tabs ?? []),
    ...state.workspaces.filter((w) => w.id !== state.activeWorkspaceId).flatMap((w) => w.tabs)
  ]
  for (const tab of tabs) {
    const leaf = collectLeaves(tab.root).find(fits)
    if (leaf) return { tabId: tab.id, paneId: leaf.id }
  }
  return undefined
}

/**
 * Where a desktop is already open for this target's account, if it is one.
 *
 * A desktop is never opened twice for one account: Windows signs a user's
 * first session out for a second. openHost brought such a one forward, and
 * a collection or a saved layout opened it again beside it.
 */
export function openDesktop(
  state: AppState,
  target: PaneTarget
): { tabId: string; paneId: string } | undefined {
  if (target.kind !== 'session') return undefined
  if (protocolOf(findHost(state, target.sessionId)?.host) !== 'rdp') return undefined
  return paneToReuse(state, target.sessionId, {
    credentialId: target.credentialId,
    admin: target.admin,
    defaultCredentialId: defaultAccountOf(state, target.sessionId),
    consoleSession: opensInConsole(state, target.sessionId)
  })
}

/**
 * Whether a desktop connects in console mode without being asked: its own or
 * its groups' setting, which the connection takes with `/admin` as it does a
 * Connect in console mode. Asked for as well, it is the same session.
 */
export function opensInConsole(state: AppState, sessionId: string): boolean {
  const found = findHost(state, sessionId)
  if (!found) return false
  return resolveRdp(found.host, found.host.groupId ?? null, found.groups).consoleSession
}

/**
 * What makes two panes the same Windows session — host, account, console or
 * not — or nothing for a target that is not a desktop.
 */
export function desktopKey(state: AppState, target: PaneTarget): string | undefined {
  if (target.kind !== 'session') return undefined
  if (protocolOf(findHost(state, target.sessionId)?.host) !== 'rdp') return undefined
  const account =
    target.credentialId === defaultAccountOf(state, target.sessionId)
      ? undefined
      : target.credentialId
  const admin = target.admin === true || opensInConsole(state, target.sessionId)
  return JSON.stringify([target.sessionId, account ?? null, admin])
}

/**
 * The account a desktop opens with when none is named. Connect as… naming
 * it is the same Windows session, and was taken for another.
 */
export function defaultAccountOf(state: AppState, sessionId: string): string | undefined {
  const found = findHost(state, sessionId)
  if (!found) return undefined
  return defaultCredential(
    authChain(found.host, found.host.groupId ?? null, found.groups, { protocol: 'rdp' }),
    state.credentials
  )?.id
}

/**
 * What each tab of a row is called on screen: its title, numbered — "web #1",
 * "web #2" — where the row holds more than one by that name, so two tabs of
 * one host can be told apart at a glance.
 *
 * Counted in the order the row shows them and only when drawn, so closing one
 * renumbers the rest and a lone tab loses its number; the title kept with the
 * tab is never changed. Titles that already differ — the "#n" of "Connect
 * several times…", or an account's name after the host's — are left alone.
 */
export function tabLabels(tabs: Pick<WorkspaceTab, 'id' | 'title'>[]): Map<string, string> {
  const total = new Map<string, number>()
  for (const tab of tabs) total.set(tab.title, (total.get(tab.title) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const tab of tabs) {
    if ((total.get(tab.title) ?? 0) < 2) {
      labels.set(tab.id, tab.title)
      continue
    }
    const n = (seen.get(tab.title) ?? 0) + 1
    seen.set(tab.title, n)
    labels.set(tab.id, `${tab.title} #${n}`)
  }
  return labels
}

/** A background workspace is flagged when any of its tabs has unread output. */
export function workspaceHasActivity(workspace: Workspace): boolean {
  return workspace.tabs.some((t) => t.hasActivity)
}
