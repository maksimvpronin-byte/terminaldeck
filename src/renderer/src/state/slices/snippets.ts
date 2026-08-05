import type { StateCreator } from 'zustand'
import type { AppState, SnippetsSlice } from './types'

export const createSnippetsSlice: StateCreator<AppState, [], [], SnippetsSlice> = (set) => ({
  snippets: [],

  loadSnippets: async () => {
    set({ snippets: await window.td.snippets.list() })
  },

  upsertSnippet: async (snippet) => {
    const saved = await window.td.snippets.save(snippet)
    set((s) => ({
      snippets: s.snippets.some((x) => x.id === saved.id)
        ? s.snippets.map((x) => (x.id === saved.id ? saved : x))
        : [...s.snippets, saved]
    }))
  },

  removeSnippet: async (id) => {
    await window.td.snippets.remove(id)
    set((s) => ({ snippets: s.snippets.filter((x) => x.id !== id) }))
  }
})
