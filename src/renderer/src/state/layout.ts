import { collectLeaves, removePane, type PaneNode } from './paneTree'
import type { WorkspaceTab } from './store'

const KEY = 'terminaldeck.layout'

interface StoredLayout {
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

export function saveLayout(tabs: WorkspaceTab[], activeTabId: string | null): void {
  try {
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
    const payload: StoredLayout = {
      version: 1,
      tabs: saved,
      activeTabId: saved.some((t) => t.id === activeTabId) ? activeTabId : (saved[0]?.id ?? null)
    }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* layout persistence is best-effort */
  }
}

export function loadLayout(): { tabs: WorkspaceTab[]; activeTabId: string | null } {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { tabs: [], activeTabId: null }
    const parsed = JSON.parse(raw) as StoredLayout
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return { tabs: [], activeTabId: null }
    return { tabs: parsed.tabs, activeTabId: parsed.activeTabId }
  } catch {
    return { tabs: [], activeTabId: null }
  }
}
