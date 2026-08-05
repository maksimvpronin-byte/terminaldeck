import type { StateCreator } from 'zustand'
import type { AppState, VaultSlice } from './types'

export const createVaultSlice: StateCreator<AppState, [], [], VaultSlice> = (set) => ({
  vaultLocked: false,

  lockVault: async () => {
    await window.td.vault.lock()
    set({ vaultLocked: true })
  },

  setVaultUnlocked: () => set({ vaultLocked: false })
})
