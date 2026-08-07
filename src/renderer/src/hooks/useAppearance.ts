import { useMemo } from 'react'
import { resolveAppearance } from '../../../shared/appearance'
import type { ResolvedAppearance } from '../../../shared/types'
import type { PaneTarget } from '../state/paneTree'
import { findHost, governingCollection } from '../state/hosts'
import { useStore } from '../state/store'

/**
 * The look a pane's terminal should wear: its host's own settings, falling back
 * through the host's groups to the application-wide defaults.
 *
 * Memoised on the pieces it reads, because the result is fed to an effect that
 * refits the terminal — a fresh object on every render would resize the pane
 * continuously.
 */
export function useAppearance(target: PaneTarget): ResolvedAppearance {
  const settings = useStore((s) => s.settings)
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const trees = useStore((s) => s.inventoryTrees)
  const overrides = useStore((s) => s.inventoryOverrides)
  const collections = useStore((s) => s.collections)

  return useMemo(() => {
    // A quick connect has no saved host to hang settings on.
    if (target.kind !== 'session') return settings
    const state = useStore.getState()
    const found = findHost(state, target.sessionId)
    if (!found) return settings
    // The collection sits between the host and its groups: it recolours a whole
    // set without overruling a host that was marked on purpose.
    const collection = governingCollection(state, target.sessionId)
    return resolveAppearance(found.host, found.host.groupId, found.groups, settings, collection)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, settings, sessions, groups, trees, overrides, collections])
}
