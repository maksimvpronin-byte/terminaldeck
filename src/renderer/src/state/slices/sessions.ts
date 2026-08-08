import type { StateCreator } from 'zustand'
import type { SessionStoreData } from '../../../../shared/types'
import type { AppState, SessionsSlice } from './types'
import { moveRelativeTo } from '../../../../shared/ordering'

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set, get) => ({
  groups: [],
  sessions: [],

  loadStore: async () => {
    const data: SessionStoreData = await window.td.store.load()
    set({ groups: data.groups, sessions: data.sessions })
  },

  upsertSession: async (session, secret) => {
    const saved = await window.td.store.saveSession(session, secret)
    set((s) => ({
      sessions: s.sessions.some((x) => x.id === saved.id)
        ? s.sessions.map((x) => (x.id === saved.id ? saved : x))
        : [...s.sessions, saved]
    }))
  },

  removeSession: async (id) => {
    await window.td.store.deleteSession(id)
    set((s) => ({ sessions: s.sessions.filter((x) => x.id !== id) }))
  },

  upsertGroup: async (group, secret) => {
    const saved = await window.td.store.saveGroup(group, secret)
    set((s) => ({
      groups: s.groups.some((x) => x.id === saved.id)
        ? s.groups.map((x) => (x.id === saved.id ? saved : x))
        : [...s.groups, saved]
    }))
  },

  removeGroup: async (id) => {
    await window.td.store.deleteGroup(id)
    set((s) => {
      // Mirror SessionStore.deleteGroup: children are adopted, not orphaned.
      const newParent = s.groups.find((g) => g.id === id)?.parentId ?? null
      return {
        groups: s.groups
          .filter((x) => x.id !== id)
          .map((g) => (g.parentId === id ? { ...g, parentId: newParent } : g)),
        sessions: s.sessions.map((x) => (x.groupId === id ? { ...x, groupId: newParent } : x))
      }
    })
  },

  moveSession: async (sessionId, groupId) => {
    const session = get().sessions.find((s) => s.id === sessionId)
    if (!session || session.groupId === groupId) return
    await get().upsertSession({ ...session, groupId, updatedAt: Date.now() })
  },

  reorderSession: async (sessionId, targetId, place) => {
    if (sessionId === targetId) return
    const { sessions } = get()
    const dragged = sessions.find((s) => s.id === sessionId)
    const target = sessions.find((s) => s.id === targetId)
    if (!dragged || !target) return

    // Landing next to a host means landing in its group: one gesture, so the
    // group change and the new position are applied together.
    const moved =
      dragged.groupId === target.groupId
        ? dragged
        : { ...dragged, groupId: target.groupId, updatedAt: Date.now() }

    const next = moveRelativeTo(
      sessions.map((s) => (s.id === sessionId ? moved : s)),
      sessionId,
      targetId,
      place
    )

    set({ sessions: next })
    if (moved !== dragged) await window.td.store.saveSession(moved)
    await window.td.store.reorderSessions(next.map((s) => s.id))
  },

  moveGroup: async (groupId, parentId) => {
    const { groups } = get()
    const group = groups.find((g) => g.id === groupId)
    if (!group || group.parentId === parentId || groupId === parentId) return
    // Refuse to nest a group inside its own subtree — that would detach the branch.
    let cursor = parentId
    while (cursor) {
      if (cursor === groupId) return
      cursor = groups.find((g) => g.id === cursor)?.parentId ?? null
    }
    await get().upsertGroup({ ...group, parentId })
  }
})
