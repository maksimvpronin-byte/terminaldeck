import type { HostCollection } from '../../../shared/types'

/**
 * Which collections a host — or every host in a group — belongs to, as the
 * host and group dialogs show it: ticked, unticked, or, for a group whose
 * hosts are only partly in a set, neither.
 */
export type Membership = 'all' | 'some' | 'none'

export function membershipOf(collection: HostCollection, hostIds: string[]): Membership {
  const held = hostIds.filter((id) => collection.hostIds.includes(id)).length
  if (hostIds.length === 0 || held === 0) return 'none'
  return held === hostIds.length ? 'all' : 'some'
}

export function membershipsOf(
  collections: HostCollection[],
  hostIds: string[]
): Record<string, Membership> {
  return Object.fromEntries(collections.map((c) => [c.id, membershipOf(c, hostIds)]))
}

/**
 * The collection with `hostIds` put in or taken out, or null when nothing
 * changes. Hosts added go at the end, in the order given, so a set somebody
 * arranged by hand keeps its order.
 */
export function withMembership(
  collection: HostCollection,
  hostIds: string[],
  wanted: Membership
): HostCollection | null {
  if (wanted === 'some' || membershipOf(collection, hostIds) === wanted) return null
  const ids =
    wanted === 'all'
      ? [...collection.hostIds, ...hostIds.filter((id) => !collection.hostIds.includes(id))]
      : collection.hostIds.filter((id) => !hostIds.includes(id))
  return { ...collection, hostIds: ids }
}

/** Every collection that the choices in a dialog change, ready to save. */
export function changedCollections(
  collections: HostCollection[],
  hostIds: string[],
  chosen: Record<string, Membership>
): HostCollection[] {
  return collections
    .map((c) => (chosen[c.id] ? withMembership(c, hostIds, chosen[c.id]) : null))
    .filter((c): c is HostCollection => c !== null)
}
