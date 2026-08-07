import { applyOverride } from '../../../shared/overrides'
import type { HostCollection, SessionGroup, SessionProfile } from '../../../shared/types'
import type { AppState } from './slices/types'

/**
 * The collection whose look a host wears: the first in the list that names it.
 *
 * A host can sit in any number of collections, so something has to break the
 * tie. Rather than invent a hidden rule, the tie-break is the visible order of
 * the list, which the user can rearrange.
 */
export function governingCollection(
  state: Pick<AppState, 'collections'>,
  hostId: string
): HostCollection | undefined {
  return state.collections.find((c) => c.hostIds.includes(hostId))
}

/**
 * The colour a host should be drawn in, everywhere it appears. Its own colour
 * wins, so a deliberately marked machine stays marked; otherwise its collection
 * lends one, which is what makes a whole set read as one environment.
 */
export function colorOf(
  state: Pick<AppState, 'collections'>,
  host: { id: string; color?: string }
): string | undefined {
  return host.color ?? governingCollection(state, host.id)?.color
}

export interface FoundHost {
  host: SessionProfile
  /** Every group of the tree it belongs to, with local overrides applied. */
  groups: SessionGroup[]
  /** Came from a repository, so edits are stored as an override, not in place. */
  fromInventory: boolean
}

/**
 * Inventory groups as the rest of the app should see them: what the repository
 * said, with the local overrides layered on top. The raw tree is what synced;
 * this is what the user actually configured.
 */
export function inventoryGroups(state: AppState): SessionGroup[] {
  return state.inventoryTrees.flatMap((tree) =>
    tree.groups.map((g) => applyOverride(g, state.inventoryOverrides.find((o) => o.nodeId === g.id)))
  )
}

/**
 * Finds a host by id in either tree. Saved sessions win over inventory ones —
 * ids come from different generators, so a clash is not expected, and picking a
 * deterministic side beats depending on iteration order.
 */
export function findHost(state: AppState, id: string): FoundHost | undefined {
  const saved = state.sessions.find((s) => s.id === id)
  if (saved) return { host: saved, groups: state.groups, fromInventory: false }

  for (const tree of state.inventoryTrees) {
    const raw = tree.sessions.find((s) => s.id === id)
    if (!raw) continue
    return {
      host: applyOverride(raw, state.inventoryOverrides.find((o) => o.nodeId === id)),
      groups: inventoryGroups(state),
      fromInventory: true
    }
  }
  return undefined
}
