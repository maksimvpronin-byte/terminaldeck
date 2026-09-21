import type { SessionGroup, SessionProfile } from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { applyOverride } from '../../../shared/overrides'
import { groupPath } from '../../../shared/groups'
import type { AppState } from './slices/types'
import type { PaneTarget } from './paneTree'
import { gitFolderGroups, inventoryGroups, overridesByNode } from './hosts'

export interface PaletteEntry {
  id: string
  title: string
  /** "Prod / Databases" or "Repo / all / db", so duplicates are tellable apart. */
  path: string
  address: string
  color?: string
  target: PaneTarget
}

export type PaletteSource = Pick<
  AppState,
  | 'sessions'
  | 'groups'
  | 'inventoryTrees'
  | 'inventoryOverrides'
  | 'gitFolderTrees'
  | 'gitFolderOverrides'
>

function entry(host: SessionProfile, groups: SessionGroup[]): PaletteEntry {
  const auth = resolveAuth(host, host.groupId, groups)
  return {
    id: host.id,
    title: host.name,
    path: groupPath(host.groupId, groups),
    address: auth.username ? `${auth.username}@${host.host}` : host.host,
    color: host.color,
    target: { kind: 'session', sessionId: host.id }
  }
}

/**
 * Every host the palette can open, with the address it will be reached at.
 *
 * Hosts from a repository are shown with the local overrides layered on — on
 * the host itself and on every group above it. A login set on a group here is
 * what a connection will use, so it is what the palette shows and searches.
 */
export function paletteEntries(state: PaletteSource): PaletteEntry[] {
  const out = state.sessions.map((s) => entry(s, state.groups))

  const invGroups = inventoryGroups(state)
  const invOverrides = overridesByNode(state.inventoryOverrides)
  for (const tree of state.inventoryTrees) {
    for (const raw of tree.sessions) {
      out.push(entry(applyOverride(raw, invOverrides.get(raw.id)), invGroups))
    }
  }

  // Hosts a Sessions folder mirrors out of git. Their path runs through the
  // folder somebody made, so the saved groups are part of the chain here.
  const folderGroups = [...state.groups, ...gitFolderGroups(state)]
  const gitOverrides = overridesByNode(state.gitFolderOverrides)
  for (const tree of state.gitFolderTrees) {
    for (const raw of tree.sessions) {
      out.push(entry(applyOverride(raw, gitOverrides.get(raw.id)), folderGroups))
    }
  }
  return out
}
