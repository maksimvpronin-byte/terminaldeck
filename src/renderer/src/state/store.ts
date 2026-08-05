import { create } from 'zustand'
import { saveLayout } from './layout'
import { createVaultSlice } from './slices/vault'
import { createSettingsSlice } from './slices/settings'
import { createSessionsSlice } from './slices/sessions'
import { createInventorySlice } from './slices/inventory'
import { createSnippetsSlice } from './slices/snippets'
import { createWorkspaceSlice } from './slices/workspace'
import type { AppState } from './slices/types'

export type { PaneNode, PaneTarget } from './paneTree'
export type { AppState, WorkspaceTab } from './slices/types'
export {
  collectConnectionIds,
  collectBroadcastTargets,
  collectLeaves,
  collectConnectedSessionIds
} from './paneTree'

/**
 * One store assembled from slices. Everything reaches everything else through
 * `get()`, so opening a selected host can look up an inventory entry without the
 * slices importing one another.
 */
export const useStore = create<AppState>()((...a) => ({
  ...createVaultSlice(...a),
  ...createSettingsSlice(...a),
  ...createSessionsSlice(...a),
  ...createInventorySlice(...a),
  ...createSnippetsSlice(...a),
  ...createWorkspaceSlice(...a)
}))

// Persist the workspace shape whenever it changes, so a restart brings the tabs
// and splits back. Connections themselves are not restored — see layout.ts.
let lastTabs = useStore.getState().tabs
let lastActive = useStore.getState().activeTabId
useStore.subscribe((state) => {
  if (state.tabs === lastTabs && state.activeTabId === lastActive) return
  lastTabs = state.tabs
  lastActive = state.activeTabId
  saveLayout(state.tabs, state.activeTabId)
})
