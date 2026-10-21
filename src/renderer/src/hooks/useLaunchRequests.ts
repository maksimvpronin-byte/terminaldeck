import { useEffect, useState } from 'react'
import { matchHosts, matchResolved } from '../../../shared/hostMatch'
import { diag } from '../diag'
import { paletteEntries } from '../state/palette'
import { useStore } from '../state/store'

/** A host from the command line that did not come down to exactly one. */
export interface LaunchRequest {
  /** What was typed after `-s`. */
  query: string
  /** The palette entries it fits: several to choose from, or none. */
  ids: string[]
}

/**
 * Opens the hosts `TerminalDeck.exe -s name` asks for — see
 * main/launchRequests.ts for how they get here.
 *
 * Taken only with the vault open: a locked window holds them until the master
 * password is in, which on a cold start is the first thing asked. The hosts
 * and inventories are read again before looking, since a copy just started may
 * not have read them yet. One match is opened as a double-click in the tree
 * would open it; several, or none, go to `ask`, which offers the choice or
 * says the host is not known.
 */
export function useLaunchRequests(ask: (request: LaunchRequest) => void): void {
  const vaultLocked = useStore((s) => s.vaultLocked)
  const [asked, setAsked] = useState(0)

  useEffect(() => window.td.launch.onRequested(() => setAsked((n) => n + 1)), [])

  useEffect(() => {
    if (vaultLocked) return
    void (async () => {
      const names = await window.td.launch.take()
      if (names.length === 0) return
      const s = useStore.getState()
      await Promise.all([s.loadStore(), s.loadInventory(), s.loadGitFolders()])
      for (const name of names) {
        const entries = paletteEntries(useStore.getState())
        let found = matchHosts(name, entries)
        if (found.length === 0) found = matchResolved(await window.td.launch.resolve(name), entries)
        diag('launch', `${name}: ${found.length} found`)
        if (found.length === 1) {
          const [one] = found
          useStore.getState().openHost(one.title, one.target, one.color)
        } else {
          ask({ query: name, ids: found.map((e) => e.id) })
        }
      }
    })()
    // `ask` is a setter's wrapper, the same in effect on every render; the
    // effect is about the lock and about new requests, nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultLocked, asked])
}
