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
      ? { ...n, connectionId: undefined, restored: true, sftpOpen: false, tunnelsOpen: false }
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
    saved.push({ ...tab, root, activePaneId })
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

export function loadLayout(): { workspaces: Workspace[]; activeWorkspaceId: string | null } {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as StoredLayout | StoredLayoutV1
    if (parsed.version === 1) return migrateV1(parsed)
    if (parsed.version !== 2 || !Array.isArray(parsed.workspaces)) return empty()
    return { workspaces: parsed.workspaces, activeWorkspaceId: parsed.activeWorkspaceId }
  } catch {
    return empty()
  }
}
