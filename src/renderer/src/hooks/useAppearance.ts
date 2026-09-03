import { useMemo } from 'react'
import { resolveAppearance } from '../../../shared/appearance'
import type { ResolvedAppearance } from '../../../shared/types'
import type { PaneTarget } from '../state/paneTree'
import { findHost } from '../state/hosts'
import { useStore } from '../state/store'

/**
 * The look a pane's terminal should wear: its host's own settings, falling back
 * through the host's groups to the application-wide defaults.
 *
 * Memoised on the pieces it reads, because the result is fed to an effect that
 * refits the terminal — a fresh object on every render would resize the pane
 * continuously.
 */
export function useAppearance(
  target: PaneTarget,
  /**
   * The collection this pane was opened from, if any. A host can be in several,
   * so nothing but the way in can answer which one lends its look — opened from
   * the tree, no collection applies and the host's groups decide.
   */
  viaCollectionId?: string
): ResolvedAppearance {
  const settings = useStore((s) => s.settings)
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const gitTrees = useStore((s) => s.gitFolderTrees)
  const gitOverrides = useStore((s) => s.gitFolderOverrides)
  const collections = useStore((s) => s.collections)

  return useMemo(() => {
    // A quick connect has no saved host to hang settings on.
    if (target.kind !== 'session') return settings
    const state = useStore.getState()
    const found = findHost(state, target.sessionId)
    if (!found) return settings
    // The collection sits between the host and its groups: it recolours a whole
    // set without overruling a host that was marked on purpose.
    const collection = viaCollectionId
      ? state.collections.find((c) => c.id === viaCollectionId)
      : undefined
    return resolveAppearance(found.host, found.host.groupId, found.groups, settings, collection)
    // The store slices are listed as triggers rather than read directly: the
    // body takes a snapshot with getState(), which is not reactive, so the
    // subscriptions above are what make this recompute. The rule sees them as
    // unused dependencies; removing them would freeze the look at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    target,
    viaCollectionId,
    settings,
    sessions,
    groups,
    trees,
    overrides,
    gitTrees,
    gitOverrides,
    collections
  ])
}
