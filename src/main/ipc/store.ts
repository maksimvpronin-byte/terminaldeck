import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type {
  Credential,
  HostCollection,
  SessionGroup,
  SessionProfile,
  Snippet
} from '../../shared/types'
import { exportToFile, importFromFile } from '../store/Backup'
import { collectionStore } from '../store/CollectionStore'
import { credentialStore } from '../store/CredentialStore'
import { sessionStore } from '../store/SessionStore'
import { snippetStore } from '../store/SnippetStore'
import { forgetGitFolder } from './gitFolders'
import { applySecret, forgetSecret, forgetSecretAt } from './secrets'
import { focusedWin } from './win'

/**
 * Saved hosts, groups, snippets, collections, stored logins, and moving the lot
 * to another machine.
 */

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
      // Untying a folder from its repository empties it: the hosts it showed
      // were the repository's, and the settings kept for them addressed nodes
      // that no longer exist.
      const had = sessionStore.getAll().groups.find((g) => g.id === group.id)?.git
      if (had && !group.git) forgetGitFolder(group.id)
      return sessionStore.saveGroup(group)
    }
  )
  ipcMain.handle(IPC.storeReorderGroups, (_e, orderedIds: string[]) => {
    sessionStore.reorderGroups(orderedIds)
  })
  ipcMain.handle(IPC.storeDeleteGroup, (_e, id: string) => {
    // Only the group's own credential: hosts and subgroups are re-parented, not
    // deleted, and keep whatever they hold themselves.
    const group = sessionStore.getAll().groups.find((g) => g.id === id)
    if (group) {
      forgetSecret(group)
      forgetSecretAt(group, 'gatewaySecretRef')
    }
    // A folder tied to git takes its mirrored tree with it, and the local
    // settings and passwords kept for the hosts in it: nothing else can address
    // those nodes once the folder is gone.
    if (group?.git) forgetGitFolder(id)
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

  // --- Stored logins ---
  ipcMain.handle(IPC.credentialsList, () => credentialStore.list())
  /**
   * Saves an account, putting whatever was typed into the vault under the
   * reference the account carries — the same two halves as saving a host, and
   * the same rule: a string stores it, null forgets it, undefined leaves what
   * is there alone.
   *
   * A method that cannot carry one drops it, so a password left in the box
   * after switching to the agent is not kept where nothing will ever use it.
   */
  ipcMain.handle(IPC.credentialsSave, (_e, credential: Credential, secret?: string | null) => {
    applySecret(credential, 'secretRef', credential.authMethod === 'agent' ? null : secret)
    return credentialStore.save(credential)
  })
  ipcMain.handle(IPC.credentialsDelete, (_e, id: string) => {
    // The secret goes with the account. Left behind it would sit in the vault
    // for good, with nothing left pointing at it.
    const credential = credentialStore.find(id)
    if (credential) forgetSecret(credential)
    credentialStore.remove(id)
  })

  ipcMain.handle(IPC.collectionsList, () => collectionStore.list())
  ipcMain.handle(IPC.collectionsSave, (_e, collection: HostCollection) =>
    collectionStore.save(collection)
  )
  ipcMain.handle(IPC.collectionsDelete, (_e, id: string) => collectionStore.remove(id))
  ipcMain.handle(IPC.collectionsReorder, (_e, ids: string[]) => collectionStore.reorder(ids))
}
