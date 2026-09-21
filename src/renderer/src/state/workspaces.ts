import { collectLeaves, type PaneNode } from './paneTree'
import type { Workspace, WorkspaceTab } from './slices/types'

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

/** A background workspace is flagged when any of its tabs has unread output. */
export function workspaceHasActivity(workspace: Workspace): boolean {
  return workspace.tabs.some((t) => t.hasActivity)
}
