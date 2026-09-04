import type { StateCreator } from 'zustand'
import type { SessionStoreData } from '../../../../shared/types'
import type { AppState, SessionsSlice } from './types'
import { moveRelativeTo } from '../../../../shared/ordering'
import { descendsFrom } from '../../../../shared/groups'

export const createSessionsSlice: StateCreator<AppState, [], [], SessionsSlice> = (set, get) => ({
  groups: [],
  sessions: [],

  loadStore: async () => {
    const data: SessionStoreData = await window.td.store.load()
    set({ groups: data.groups, sessions: data.sessions })
  },

  upsertSession: async (session, secret, gatewaySecret) => {
    const saved = await window.td.store.saveSession(session, secret, gatewaySecret)
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

  upsertGroup: async (group, secret, gatewaySecret) => {
    const saved = await window.td.store.saveGroup(group, secret, gatewaySecret)
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

  reorderGroup: async (groupId, targetId, place) => {
    if (groupId === targetId) return
    const { groups } = get()
    const dragged = groups.find((g) => g.id === groupId)
    const target = groups.find((g) => g.id === targetId)
    if (!dragged || !target) return
    /*
     * Landing beside a folder means landing at its level, so this is a move as
     * well as a sort — the same one gesture that drops a host beside another
     * one and into its group.
     *
     * Which is why the target cannot be inside the folder being dragged: that
     * would ask the folder to become its own descendant, and the branch would
     * come away with it. Refused rather than half-applied.
     */
    if (descendsFrom(groups, target.parentId, groupId)) return

    const moved =
      dragged.parentId === target.parentId ? dragged : { ...dragged, parentId: target.parentId }
    const next = moveRelativeTo(
      groups.map((g) => (g.id === groupId ? moved : g)),
      groupId,
      targetId,
      place
    )

    set({ groups: next })
    if (moved !== dragged) await window.td.store.saveGroup(moved)
    await window.td.store.reorderGroups(next.map((g) => g.id))
  },

  moveGroup: async (groupId, parentId) => {
    const { groups } = get()
    const group = groups.find((g) => g.id === groupId)
    if (!group || group.parentId === parentId) return
    // Refuse to nest a group inside its own subtree — that would detach the branch.
    if (descendsFrom(groups, parentId, groupId)) return
    await get().upsertGroup({ ...group, parentId })
  }
})
