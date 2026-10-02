import { nanoid } from 'nanoid'
import { collectLeaves, removePane, type PaneNode } from './paneTree'
// Straight from the slice types, not from the store: the store imports this
// module, and pointing back at it would close a cycle.
import type { Workspace, WorkspaceTab } from './slices/types'

const KEY = 'terminaldeck.layout'

interface StoredLayout {
  version: 2
  workspaces: Workspace[]
  activeWorkspaceId: string | null
}

/** The single-level shape written before workspaces existed. */
export interface StoredLayoutV1 {
  version: 1
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

/**
 * Strips a saved tree down to what is safe and meaningful to restore: live
 * connection ids are gone after a restart, and quick-connect panes carry the
 * password in their target, which must never reach disk in the clear.
 */
function sanitise(node: PaneNode): PaneNode | null {
  let result: PaneNode | null = node
  for (const leaf of collectLeaves(node)) {
    if (leaf.target.kind === 'quick' && result) result = removePane(result, leaf.id)
  }
  if (!result) return null

  const strip = (n: PaneNode): PaneNode =>
    n.type === 'leaf'
      ? {
          ...n,
          connectionId: undefined,
          desktopId: undefined,
          restored: true,
          sftpOpen: false,
          tunnelsOpen: false,
          monitorOpen: false
        }
      : { ...n, children: [strip(n.children[0]), strip(n.children[1])] }
  return strip(result)
}

function sanitiseTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  const saved: WorkspaceTab[] = []
  for (const tab of tabs) {
    const root = sanitise(tab.root)
    if (!root) continue
    const leaves = collectLeaves(root)
    const activePaneId = leaves.some((l) => l.id === tab.activePaneId)
      ? tab.activePaneId
      : leaves[0].id
    // Nothing has happened in a restored pane yet, whatever the tab had seen
    // before the restart; a dot on it would point at output that is gone.
    saved.push({ ...tab, root, activePaneId, hasActivity: undefined })
  }
  return saved
}

export function saveLayout(workspaces: Workspace[], activeWorkspaceId: string | null): void {
  try {
    const saved: Workspace[] = []
    for (const workspace of workspaces) {
      const tabs = sanitiseTabs(workspace.tabs)
      // A workspace whose tabs were all quick connects has nothing to restore.
      if (tabs.length === 0) continue
      saved.push({
        ...workspace,
        tabs,
        activeTabId: tabs.some((t) => t.id === workspace.activeTabId)
          ? workspace.activeTabId
          : tabs[0].id
      })
    }
    const payload: StoredLayout = {
      version: 2,
      workspaces: saved,
      activeWorkspaceId: saved.some((w) => w.id === activeWorkspaceId)
        ? activeWorkspaceId
        : (saved[0]?.id ?? null)
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* layout persistence is best-effort */
  }
}

function empty(): { workspaces: Workspace[]; activeWorkspaceId: string | null } {
  return { workspaces: [], activeWorkspaceId: null }
}

/**
 * Everything a v1 layout held becomes the tabs of a single workspace.
 * Exported for its own test: losing this silently would empty someone's
 * restored layout on the upgrade, with nothing to point at afterwards.
 */
export function migrateV1(parsed: StoredLayoutV1): {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
} {
  if (!Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return empty()
  const workspace: Workspace = {
    id: nanoid(),
    title: 'Workspace 1',
    tabs: parsed.tabs,
    activeTabId: parsed.tabs.some((t) => t.id === parsed.activeTabId)
      ? parsed.activeTabId
      : parsed.tabs[0].id
  }
  return { workspaces: [workspace], activeWorkspaceId: workspace.id }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Stored JSON is checked before any component recursively walks the pane tree. */
function validTabs(
  value: unknown,
  tabIds = new Set<string>(),
  paneIds = new Set<string>()
): value is WorkspaceTab[] {
  const uniqueId = (value: unknown, ids: Set<string>): boolean => {
    if (typeof value !== 'string' || !value || ids.has(value)) return false
    ids.add(value)
    return true
  }
  const pane = (value: unknown, depth: number): boolean => {
    if (depth > 64 || !record(value) || !uniqueId(value.id, paneIds)) return false
    if (value.type === 'leaf') {
      if (typeof value.title !== 'string' || !record(value.target)) return false
      return (
        value.target.kind === 'quick' ||
        (value.target.kind === 'session' && typeof value.target.sessionId === 'string')
      )
    }
    return (
      value.type === 'split' &&
      (value.dir === 'row' || value.dir === 'col') &&
      Array.isArray(value.sizes) &&
      value.sizes.length === 2 &&
      value.sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0) &&
      Array.isArray(value.children) &&
      value.children.length === 2 &&
      value.children.every((child) => pane(child, depth + 1))
    )
  }
  return (
    Array.isArray(value) &&
    value.every(
      (tab) =>
        record(tab) &&
        uniqueId(tab.id, tabIds) &&
        typeof tab.title === 'string' &&
        pane(tab.root, 0)
    )
  )
}

export function loadLayout(): { workspaces: Workspace[]; activeWorkspaceId: string | null } {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed: unknown = JSON.parse(raw)
    if (!record(parsed)) return empty()
    if (parsed.version === 1) {
      if (!validTabs(parsed.tabs)) return empty()
      return migrateV1({
        version: 1,
        tabs: sanitiseTabs(parsed.tabs),
        activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null
      })
    }
    if (parsed.version !== 2 || !Array.isArray(parsed.workspaces)) return empty()
    const workspaceIds = new Set<string>()
    const tabIds = new Set<string>()
    const paneIds = new Set<string>()
    const workspaces: Workspace[] = []
    for (const workspace of parsed.workspaces) {
      if (
        !record(workspace) ||
        typeof workspace.id !== 'string' ||
        !workspace.id ||
        workspaceIds.has(workspace.id) ||
        typeof workspace.title !== 'string' ||
        !validTabs(workspace.tabs, tabIds, paneIds)
      )
        return empty()
      workspaceIds.add(workspace.id)
      const tabs = sanitiseTabs(workspace.tabs)
      workspaces.push({
        id: workspace.id,
        title: workspace.title,
        color: typeof workspace.color === 'string' ? workspace.color : undefined,
        collectionId:
          typeof workspace.collectionId === 'string' ? workspace.collectionId : undefined,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === workspace.activeTabId)
          ? (workspace.activeTabId as string)
          : (tabs[0]?.id ?? null)
      })
    }
    const activeWorkspaceId = workspaces.some(
      (workspace) => workspace.id === parsed.activeWorkspaceId
    )
      ? (parsed.activeWorkspaceId as string)
      : (workspaces[0]?.id ?? null)
    return { workspaces, activeWorkspaceId }
  } catch {
    return empty()
  }
}
