import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { InventoryOverride, InventorySource } from '../../shared/types'
import { isGitAvailable } from '../inventory/GitRepo'
import { inventoryStore } from '../inventory/InventoryStore'
import { SECRET_FIELDS, forgetSecretsAt, saveWithSecrets } from './secrets'

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
    // too — along with the repository's own, and the gateway passwords as well
    // as the logins: only the logins went, and the rest stayed in the vault
    // with nothing left that could reach them.
    // Removed first and forgotten after: a removal that fails to save must not
    // have already taken the passwords of a source that is still there.
    const source = inventoryStore.sources().find((s) => s.id === id)
    const overrides = inventoryStore.overrides().filter((o) => o.nodeId.startsWith(`inv:${id}:`))
    inventoryStore.removeSource(id)
    forgetSecretsAt([...(source ? [source] : []), ...overrides], [...SECRET_FIELDS])
  })
  ipcMain.handle(IPC.inventorySync, (_e, id: string) => inventoryStore.sync(id))
  ipcMain.handle(IPC.inventorySyncAll, () => inventoryStore.syncAll())
  ipcMain.handle(
    IPC.inventorySaveOverride,
    (_e, override: InventoryOverride, secret?: string | null, gatewaySecret?: string | null) => {
      saveWithSecrets(
        override,
        [
          ['secretRef', secret],
          ['gatewaySecretRef', gatewaySecret]
        ],
        (o) => inventoryStore.saveOverride(o)
      )
    }
  )
  ipcMain.handle(IPC.inventoryClearOverride, (_e, nodeId: string) => {
    const override = inventoryStore.overrides().find((o) => o.nodeId === nodeId)
    inventoryStore.clearOverride(nodeId)
    if (override) forgetSecretsAt([override], [...SECRET_FIELDS])
  })
}
