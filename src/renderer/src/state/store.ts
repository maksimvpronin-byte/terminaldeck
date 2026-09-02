import { create } from 'zustand'
import { saveLayout } from './layout'
import { createVaultSlice } from './slices/vault'
import { createSettingsSlice } from './slices/settings'
import { createSessionsSlice } from './slices/sessions'
import { createInventorySlice } from './slices/inventory'
import { createSnippetsSlice } from './slices/snippets'
import { createCollectionsSlice } from './slices/collections'
import { createCredentialsSlice } from './slices/credentials'
import { createWorkspaceSlice } from './slices/workspace'
import type { AppState } from './slices/types'

export type { PaneNode, PaneTarget } from './paneTree'
export type { AppState, OpenMode, OpenRequest, Workspace, WorkspaceTab } from './slices/types'
export {
  activeTab,
  activeWorkspace,
  allRoots,
  allTabs,
  findTab,
  workspaceHasActivity,
  workspaceOfTab
} from './workspaces'
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
  ...createCollectionsSlice(...a),
  ...createCredentialsSlice(...a),
  ...createWorkspaceSlice(...a)
}))

// Persist the workspace shape whenever it changes, so a restart brings the
// workspaces, tabs and splits back. Connections themselves are not restored —
// see layout.ts.
let lastWorkspaces = useStore.getState().workspaces
let lastActive = useStore.getState().activeWorkspaceId
useStore.subscribe((state) => {
  if (state.workspaces === lastWorkspaces && state.activeWorkspaceId === lastActive) return
  lastWorkspaces = state.workspaces
  lastActive = state.activeWorkspaceId
  saveLayout(state.workspaces, state.activeWorkspaceId)
})
