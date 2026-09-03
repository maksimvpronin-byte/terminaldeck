import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { InventoryOverride } from '../../shared/types'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { applySecret, forgetSecret, forgetSecretAt } from './secrets'

/**
 * Sessions folders backed by git: what they hold, pulling a repository, taking
 * the result, and the local settings layered over what it produced.
 */

/** A node that has gone takes its login and its gateway login with it. */
function forgetBoth(override: InventoryOverride): void {
  forgetSecret(override)
  forgetSecretAt(override, 'gatewaySecretRef')
}

export function registerGitFolderHandlers(): void {
  ipcMain.handle(IPC.gitFolderList, () => ({
    trees: gitFolderStore.trees(),
    overrides: gitFolderStore.overrides(),
    repos: gitFolderStore.repos()
  }))

  ipcMain.handle(IPC.gitFolderForgetRepo, (_e, url: string, branch?: string) =>
    gitFolderStore.forgetRepo(url, branch)
  )

  // Reads the repository and says what taking it would mean. Nothing is written
  // until the window comes back with an answer.
  ipcMain.handle(IPC.gitFolderPreview, (_e, groupId: string) => gitFolderStore.preview(groupId))

  ipcMain.handle(IPC.gitFolderApply, (_e, groupId: string, includedGroups: string[]) =>
    gitFolderStore.apply(groupId, includedGroups, forgetBoth)
  )

  ipcMain.handle(
    IPC.gitFolderSaveOverride,
    (_e, override: InventoryOverride, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(override, 'secretRef', secret)
      applySecret(override, 'gatewaySecretRef', gatewaySecret)
      return gitFolderStore.saveOverride(override)
    }
  )

  ipcMain.handle(IPC.gitFolderClearOverride, (_e, nodeId: string) => {
    const override = gitFolderStore.overrides().find((o) => o.nodeId === nodeId)
    if (override) forgetBoth(override)
    return gitFolderStore.clearOverride(nodeId)
  })
}

/**
 * Everything a folder's link left behind, for when the folder — or just the
 * link — is taken away. Exported rather than registered: the session store owns
 * both of those moments.
 */
export function forgetGitFolder(groupId: string): void {
  gitFolderStore.forget(groupId, forgetBoth)
}
