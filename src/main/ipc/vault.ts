import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { trustedCertificates } from '../rdp/CertificateTrust'
import { knownHosts } from '../ssh/KnownHosts'
import { WrongPasswordError, vault } from '../vault/Vault'

/** The vault itself, and the keys and certificates trusted by hand. */

export function registerVaultHandlers(): void {
  // --- Vault ---
  ipcMain.handle(IPC.vaultStatus, () => vault.status())
  ipcMain.handle(IPC.vaultCreate, async (_e, password: string) => {
    await vault.create(password)
    return vault.status()
  })
  ipcMain.handle(IPC.vaultUnlock, async (_e, password: string) => {
    try {
      await vault.unlock(password)
      return { ok: true, status: vault.status() }
    } catch (err) {
      if (err instanceof WrongPasswordError) return { ok: false, error: err.message }
      throw err
    }
  })
  ipcMain.handle(IPC.vaultLock, () => {
    vault.lock()
    return vault.status()
  })
  ipcMain.handle(IPC.vaultChangePassword, async (_e, current: string, next: string) => {
    try {
      await vault.changePassword(current, next)
      return { ok: true }
    } catch (err) {
      if (err instanceof WrongPasswordError) return { ok: false, error: err.message }
      throw err
    }
  })


  // --- Trusted host keys ---
  ipcMain.handle(IPC.knownHostsList, () =>
    Object.entries(knownHosts.all()).map(([host, fingerprint]) => ({ host, fingerprint }))
  )
  ipcMain.handle(IPC.knownHostsRemove, (_e, host: string) => knownHosts.removeByKey(host))
  ipcMain.handle(IPC.knownCertificatesList, () =>
    Object.entries(trustedCertificates.all()).map(([host, fingerprint]) => ({ host, fingerprint }))
  )
  ipcMain.handle(IPC.knownCertificatesRemove, (_e, host: string) =>
    trustedCertificates.removeByKey(host)
  )

}
