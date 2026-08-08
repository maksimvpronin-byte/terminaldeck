import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { SessionGroup, SessionProfile, SessionStoreData } from '../../shared/types'
import { applyOrder } from '../../shared/ordering'

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

  private load(): SessionStoreData {
    const p = storePath()
    if (!existsSync(p)) return empty()
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as SessionStoreData
    } catch {
      return empty()
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(storePath(), JSON.stringify(this.data, null, 2), 'utf8')
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
