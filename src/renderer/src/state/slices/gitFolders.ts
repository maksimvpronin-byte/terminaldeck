import type { StateCreator } from 'zustand'
import type { AppState, GitFoldersSlice } from './types'

/**
 * Sessions folders that mirror an inventory out of git.
 *
 * Nothing here runs on its own. The tree was written to disk by the last sync
 * and is read once when the window opens; going to the repository happens when
 * somebody asks, and what it brings back is applied only after the dialog it
 * opens has been answered.
 */
export const createGitFoldersSlice: StateCreator<AppState, [], [], GitFoldersSlice> = (
  set,
  get
) => ({
  gitFolderTrees: [],
  gitFolderOverrides: [],
  gitFolderSyncing: [],
  gitFolderErrors: {},

  loadGitFolders: async () => {
    const data = await window.td.gitFolder.list()
    set({ gitFolderTrees: data.trees, gitFolderOverrides: data.overrides })
  },

  previewGitFolder: async (groupId) => {
    set((s) => ({
      gitFolderSyncing: [...s.gitFolderSyncing, groupId],
      gitFolderErrors: Object.fromEntries(
        Object.entries(s.gitFolderErrors).filter(([id]) => id !== groupId)
      )
    }))
    try {
      return await window.td.gitFolder.preview(groupId)
    } catch (err) {
      // Shown under the folder rather than thrown away: a repository that cannot
      // be reached is the ordinary failure here, and the folder goes on showing
      // what it already has.
      const message = (err as Error).message || 'Sync failed'
      set((s) => ({ gitFolderErrors: { ...s.gitFolderErrors, [groupId]: message } }))
      return undefined
    } finally {
      set((s) => ({ gitFolderSyncing: s.gitFolderSyncing.filter((id) => id !== groupId) }))
      // The folder itself records what the attempt did, successful or not.
      await get().loadStore()
    }
  },

  applyGitFolder: async (groupId, includedGroups) => {
    await window.td.gitFolder.apply(groupId, includedGroups)
    await Promise.all([get().loadGitFolders(), get().loadStore()])
  },

  saveGitFolderOverride: async (override, secret, gatewaySecret) => {
    await window.td.gitFolder.saveOverride(override, secret, gatewaySecret)
    await get().loadGitFolders()
  },

  clearGitFolderOverride: async (nodeId) => {
    await window.td.gitFolder.clearOverride(nodeId)
    await get().loadGitFolders()
  }
})
