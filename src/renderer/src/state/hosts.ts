import { applyOverride } from '../../../shared/overrides'
import type { HostCollection, SessionGroup, SessionProfile } from '../../../shared/types'
import type { AppState } from './slices/types'

/**
 * The colour a host is drawn in, in a given context.
 *
 * A host may belong to any number of collections, so there is no such thing as
 * "the" collection of a host — only the one you are looking at it through, or
 * opened it from. Where there is no such context, the host answers for itself.
 */
export function colorOf(
  host: { color?: string },
  collection?: Pick<HostCollection, 'color'>
): string | undefined {
  return host.color ?? collection?.color
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
