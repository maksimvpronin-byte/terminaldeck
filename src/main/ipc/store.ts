import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HostCollection, SessionGroup, SessionProfile, Snippet } from '../../shared/types'
import { exportToFile, importFromFile } from '../store/Backup'
import { collectionStore } from '../store/CollectionStore'
import { sessionStore } from '../store/SessionStore'
import { snippetStore } from '../store/SnippetStore'
import { applySecret, forgetSecret, forgetSecretAt } from './secrets'
import { focusedWin } from './win'

/** Saved hosts, groups, snippets, collections, and moving the lot to another machine. */

export function registerStoreHandlers(): void {
  // --- Session store ---
  ipcMain.handle(IPC.storeLoad, () => sessionStore.getAll())
  ipcMain.handle(
    IPC.storeSaveSession,
    (_e, session: SessionProfile, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(session, 'secretRef', secret)
      applySecret(session, 'gatewaySecretRef', gatewaySecret)
      return sessionStore.saveSession(session)
    }
  )
  ipcMain.handle(IPC.storeDeleteSession, (_e, id: string) => {
    // The credential goes with the host. Left behind it would sit in the vault
    // for good, since nothing points at it any more.
    const session = sessionStore.getAll().sessions.find((s) => s.id === id)
    if (session) {
      forgetSecret(session)
      forgetSecretAt(session, 'gatewaySecretRef')
    }
    sessionStore.deleteSession(id)
  })
  ipcMain.handle(IPC.storeReorderSessions, (_e, orderedIds: string[]) => {
    sessionStore.reorderSessions(orderedIds)
  })
  ipcMain.handle(
    IPC.storeSaveGroup,
    (_e, group: SessionGroup, secret?: string | null, gatewaySecret?: string | null) => {
      applySecret(group, 'secretRef', secret)
      applySecret(group, 'gatewaySecretRef', gatewaySecret)
      return sessionStore.saveGroup(group)
    }
  )
  ipcMain.handle(IPC.storeDeleteGroup, (_e, id: string) => {
    // Only the group's own credential: hosts and subgroups are re-parented, not
    // deleted, and keep whatever they hold themselves.
    const group = sessionStore.getAll().groups.find((g) => g.id === id)
    if (group) {
      forgetSecret(group)
      forgetSecretAt(group, 'gatewaySecretRef')
    }
    return sessionStore.deleteGroup(id)
  })


  // --- Backup ---
  ipcMain.handle(IPC.backupExport, (_e, includeSecrets: boolean, password?: string) =>
    exportToFile(focusedWin(), includeSecrets, password)
  )
  ipcMain.handle(IPC.backupImport, (_e, password?: string) =>
    importFromFile(focusedWin(), password)
  )


  // --- Snippets ---
  ipcMain.handle(IPC.snippetsList, () => snippetStore.list())
  ipcMain.handle(IPC.snippetsSave, (_e, snippet: Snippet) => snippetStore.save(snippet))
  ipcMain.handle(IPC.snippetsDelete, (_e, id: string) => snippetStore.remove(id))

  ipcMain.handle(IPC.collectionsList, () => collectionStore.list())
  ipcMain.handle(IPC.collectionsSave, (_e, collection: HostCollection) =>
    collectionStore.save(collection)
  )
  ipcMain.handle(IPC.collectionsDelete, (_e, id: string) => collectionStore.remove(id))
  ipcMain.handle(IPC.collectionsReorder, (_e, ids: string[]) => collectionStore.reorder(ids))

}
