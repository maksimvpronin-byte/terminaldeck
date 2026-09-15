import { app } from 'electron'
import { join } from 'path'
import type { SessionGroup, SessionProfile, SessionStoreData } from '../../shared/types'
import { applyOrder } from '../../shared/ordering'
import { JsonDocument, readJson } from './jsonFile'

function storePath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

function empty(): SessionStoreData {
  return { version: 1, groups: [], sessions: [] }
}

/** Replaces the entry with the same id, or adds it at the end. */
function upsert<T extends { id: string }>(list: T[], item: T): void {
  const idx = list.findIndex((existing) => existing.id === item.id)
  if (idx >= 0) list[idx] = item
  else list.push(item)
}

class SessionStore {
  /**
   * The tree, read once and written through a temporary file and a rename —
   * this is the file holding every host, group and setting, rewritten on each
   * edit and each drag — and changed only by way of a copy that reached the
   * disk. See JsonDocument.
   *
   * Reading does not quietly throw the tree away when it cannot: returning an
   * empty one from a failed parse would show no hosts, which reads as "my
   * sessions are gone", and the first save after that would write the empty
   * tree over the file that still held them. A damaged file is put aside under
   * a name of its own instead, so what is left of it can be repaired by hand.
   */
  private doc = new JsonDocument<SessionStoreData>(storePath, (path) =>
    readJson<SessionStoreData>(path, empty)
  )

  getAll(): SessionStoreData {
    return this.doc.data
  }

  saveSession(session: SessionProfile): SessionProfile {
    this.doc.change((d) => upsert(d.sessions, session))
    return session
  }

  /** The order the sidebar shows hosts in, saved as the array's own order. */
  reorderSessions(orderedIds: string[]): void {
    this.doc.change((d) => {
      d.sessions = applyOrder(d.sessions, orderedIds)
    })
  }

  deleteSession(id: string): void {
    this.doc.change((d) => {
      d.sessions = d.sessions.filter((s) => s.id !== id)
    })
  }

  /**
   * The order the sidebar shows folders in, saved as the array's own order —
   * the same arrangement hosts have always had. A folder is where you put it,
   * and where you put it is worth keeping: the tree is read far more often than
   * it is edited, and alphabetical is not the order anything is used in.
   */
  reorderGroups(orderedIds: string[]): void {
    this.doc.change((d) => {
      d.groups = applyOrder(d.groups, orderedIds)
    })
  }

  saveGroup(group: SessionGroup): SessionGroup {
    this.doc.change((d) => upsert(d.groups, group))
    return group
  }

  /** Several groups and hosts in one write, for an import. */
  saveMany(groups: SessionGroup[], sessions: SessionProfile[]): void {
    this.doc.change((d) => {
      for (const group of groups) upsert(d.groups, group)
      for (const session of sessions) upsert(d.sessions, session)
    })
  }

  deleteGroup(id: string): void {
    this.doc.change((d) => {
      const removed = d.groups.find((g) => g.id === id)
      const newParent = removed?.parentId ?? null
      d.groups = d.groups
        .filter((g) => g.id !== id)
        // subgroups are adopted by the removed group's parent rather than orphaned
        .map((g) => (g.parentId === id ? { ...g, parentId: newParent } : g))
      // sessions of the removed group move up too, instead of being deleted
      d.sessions = d.sessions.map((s) => (s.groupId === id ? { ...s, groupId: newParent } : s))
    })
  }

  snapshot(): SessionStoreData {
    return this.doc.snapshot()
  }

  restore(previous: SessionStoreData): void {
    this.doc.restore(previous)
  }
}

export const sessionStore = new SessionStore()
