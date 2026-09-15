import type { SessionGroup, SessionProfile } from '../../shared/types'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import { sessionStore } from './SessionStore'

/**
 * A host by id, and the groups settings are inherited along — wherever either
 * is kept.
 *
 * Hosts live in three places: saved by hand, read from an Inventory source, or
 * mirrored into a Sessions folder out of git. Each place that connected to one
 * spelled out the three-way lookup for itself, and the renderer has had one
 * `findHost` for a while; this is the same thing for the main process, so a
 * fourth place to keep hosts is added here once rather than wherever a
 * connection is made.
 */
export function findProfile(sessionId: string): SessionProfile | undefined {
  return (
    sessionStore.getAll().sessions.find((s) => s.id === sessionId) ??
    inventoryStore.findSession(sessionId) ??
    gitFolderStore.findSession(sessionId)
  )
}

/** Every group a host can inherit from, local overrides applied. */
export function everyGroup(): SessionGroup[] {
  return [
    ...sessionStore.getAll().groups,
    ...inventoryStore.allGroups(),
    ...gitFolderStore.allGroups()
  ]
}
