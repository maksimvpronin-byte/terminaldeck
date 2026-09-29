import { activeTab, allTabs, useStore } from './store'

/**
 * Where the window stood before a click on a host moved it.
 *
 * A single click on a host that is already open brings its pane forward, even
 * in another workspace. A double-click is that click twice and then the
 * double-click itself, so by the time it asked for a new tab the window had
 * already been taken to the old one, and the tab opened there — which from a
 * collection looked like the host refusing to open at all and jumping to the
 * copy that was already running. The double-click goes back first, and opens
 * where it was aimed.
 */
export interface Place {
  workspaceId: string | null
  tabId: string | undefined
}

export function currentPlace(): Place {
  const state = useStore.getState()
  return { workspaceId: state.activeWorkspaceId, tabId: activeTab(state)?.id }
}

/** Back to a place taken by `currentPlace`, as far as it still exists. */
export function returnTo(place: Place | null): void {
  if (!place) return
  const state = useStore.getState()
  if (place.tabId && allTabs(state).some((t) => t.id === place.tabId)) {
    state.setActiveTab(place.tabId)
  } else if (place.workspaceId && state.workspaces.some((w) => w.id === place.workspaceId)) {
    state.setActiveWorkspace(place.workspaceId)
  }
}
