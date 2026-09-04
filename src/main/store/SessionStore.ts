import { app } from 'electron'
import { join } from 'path'
import type { SessionGroup, SessionProfile, SessionStoreData } from '../../shared/types'
import { applyOrder } from '../../shared/ordering'
import { readJson, writeJson } from './jsonFile'

function storePath(): string {
  return join(app.getPath('userData'), 'sessions.json')
}

function empty(): SessionStoreData {
  return { version: 1, groups: [], sessions: [] }
}

class SessionStore {
  private data: SessionStoreData

  constructor() {
    this.data = this.load()
  }

  /**
   * Reads the tree, and does not quietly throw it away when it cannot.
   *
   * Returning an empty tree from a failed parse is the obvious thing and the
   * wrong one: the window then shows no hosts, which reads as "my sessions are
   * gone", and the first save after that writes the empty tree over the file
   * that still held them. A damaged file is put aside under a name of its own
   * instead, so what is left of it survives long enough to be repaired by hand.
   */
  private load(): SessionStoreData {
    return readJson<SessionStoreData>(storePath(), empty)
  }

  /**
   * Writes through a temporary file and a rename, as the vault and the
   * collection store already did.
   *
   * This one wrote in place, which is a truncated file the moment anything
   * interrupts it — and this is the file holding every host, group and setting,
   * rewritten on each edit and each drag. The two files that were treated
   * carefully are the two that are written least.
   */
  private persist(): void {
    writeJson(storePath(), this.data)
  }

  getAll(): SessionStoreData {
    return this.data
  }

  saveSession(session: SessionProfile): SessionProfile {
    const idx = this.data.sessions.findIndex((s) => s.id === session.id)
    if (idx >= 0) this.data.sessions[idx] = session
    else this.data.sessions.push(session)
    this.persist()
    return session
  }

  /** The order the sidebar shows hosts in, saved as the array's own order. */
  reorderSessions(orderedIds: string[]): void {
    this.data.sessions = applyOrder(this.data.sessions, orderedIds)
    this.persist()
  }

  deleteSession(id: string): void {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    this.persist()
  }

  /**
   * The order the sidebar shows folders in, saved as the array's own order —
   * the same arrangement hosts have always had. A folder is where you put it,
   * and where you put it is worth keeping: the tree is read far more often than
   * it is edited, and alphabetical is not the order anything is used in.
   */
  reorderGroups(orderedIds: string[]): void {
    this.data.groups = applyOrder(this.data.groups, orderedIds)
    this.persist()
  }

  saveGroup(group: SessionGroup): SessionGroup {
    const idx = this.data.groups.findIndex((g) => g.id === group.id)
    if (idx >= 0) this.data.groups[idx] = group
    else this.data.groups.push(group)
    this.persist()
    return group
  }

  deleteGroup(id: string): void {
    const removed = this.data.groups.find((g) => g.id === id)
    const newParent = removed?.parentId ?? null
    this.data.groups = this.data.groups
      .filter((g) => g.id !== id)
      // subgroups are adopted by the removed group's parent rather than orphaned
      .map((g) => (g.parentId === id ? { ...g, parentId: newParent } : g))
    // sessions of the removed group move up too, instead of being deleted
    this.data.sessions = this.data.sessions.map((s) =>
      s.groupId === id ? { ...s, groupId: newParent } : s
    )
    this.persist()
  }
}

export const sessionStore = new SessionStore()
