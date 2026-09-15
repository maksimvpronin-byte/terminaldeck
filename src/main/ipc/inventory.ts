import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { InventoryOverride, InventorySource } from '../../shared/types'
import { isGitAvailable } from '../inventory/GitRepo'
import { inventoryStore } from '../inventory/InventoryStore'
import { applySecret, forgetSecret, forgetSecretAt } from './secrets'

/** Inventory repositories, their syncs, and the local overrides on top of them. */

export function registerInventoryHandlers(): void {
  // --- Inventory ---
  ipcMain.handle(IPC.inventoryGitAvailable, () => isGitAvailable())
  ipcMain.handle(IPC.inventoryList, () => ({
    sources: inventoryStore.sources(),
    overrides: inventoryStore.overrides(),
    trees: inventoryStore.allTrees()
  }))
  ipcMain.handle(IPC.inventorySaveSource, (_e, source: InventorySource) =>
    inventoryStore.saveSource(source)
  )
  ipcMain.handle(IPC.inventoryRemoveSource, (_e, id: string) => {
    // Removing a repository takes its overrides with it, so their credentials go
    // too — along with the repository's own.
    // Removed first and forgotten after: a removal that fails to save must not
    // have already taken the passwords of a source that is still there.
    const source = inventoryStore.sources().find((s) => s.id === id)
    const overrides = inventoryStore.overrides().filter((o) => o.nodeId.startsWith(`inv:${id}:`))
    inventoryStore.removeSource(id)
    if (source) forgetSecret({ ...source })
    for (const override of overrides) forgetSecret({ ...override })
  })
  ipcMain.handle(IPC.inventorySync, (_e, id: string) => inventoryStore.sync(id))
  ipcMain.handle(IPC.inventorySyncAll, () => inventoryStore.syncAll())
  ipcMain.handle(
    IPC.inventorySaveOverride,
    (_e, override: InventoryOverride, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(override, 'secretRef', secret)
      applySecret(override, 'gatewaySecretRef', gatewaySecret)
      return inventoryStore.saveOverride(override)
    }
  )
  ipcMain.handle(IPC.inventoryClearOverride, (_e, nodeId: string) => {
    const override = inventoryStore.overrides().find((o) => o.nodeId === nodeId)
    inventoryStore.clearOverride(nodeId)
    if (override) {
      forgetSecret({ ...override })
      forgetSecretAt({ ...override }, 'gatewaySecretRef')
    }
  })
}
