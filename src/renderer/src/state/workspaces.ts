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

/** A background workspace is flagged when any of its tabs has unread output. */
export function workspaceHasActivity(workspace: Workspace): boolean {
  return workspace.tabs.some((t) => t.hasActivity)
}
