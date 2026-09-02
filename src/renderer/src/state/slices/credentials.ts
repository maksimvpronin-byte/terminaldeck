import type { StateCreator } from 'zustand'
import type { AppState, CredentialsSlice } from './types'

export const createCredentialsSlice: StateCreator<AppState, [], [], CredentialsSlice> = (
  set,
  get
) => ({
  credentials: [],

  loadCredentials: async () => {
    set({ credentials: await window.td.credentials.list() })
  },

  upsertCredential: async (credential, secret) => {
    await window.td.credentials.save({ ...credential, updatedAt: Date.now() }, secret)
    // Re-read rather than merging the answer in: the main process decides what
    // the saved record ends up holding — an agent login keeps no secret
    // reference however one was typed — and guessing that here is how the list
    // comes to disagree with the file.
    await get().loadCredentials()
  },

  removeCredential: async (id) => {
    await window.td.credentials.remove(id)
    await get().loadCredentials()
  }
})
