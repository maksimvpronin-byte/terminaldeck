import { useEffect, useState } from 'react'
import Sidebar from './Sidebar'
import Workspace from './Workspace'
import UpdateBanner from './UpdateBanner'
import WhatsNewBanner from './WhatsNew'
import SnippetPalette from './SnippetPalette'
import AuthPromptDialog from './AuthPromptDialog'
import HelpDialog from './HelpDialog'
import HostPalette from './HostPalette'
import { useShortcuts, useIdleLock, useZoom } from '../hooks/useShortcuts'
import { type LaunchRequest, useLaunchRequests } from '../hooks/useLaunchRequests'
import { useStore } from '../state/store'

export default function MainLayout(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [hostsOpen, setHostsOpen] = useState(false)
  // Hosts from `-s` waiting for a choice, or to be told they are not known.
  const [launchAsks, setLaunchAsks] = useState<LaunchRequest[]>([])
  useLaunchRequests((request) => setLaunchAsks((asks) => [...asks, request]))
  const loadSnippets = useStore((s) => s.loadSnippets)
  // Loaded up front, not just when the Inventory tab is opened: the host
  // palette searches inventory hosts too.
  const loadInventory = useStore((s) => s.loadInventory)
  /**
   * What the folders tied to git already hold, read from disk. This is the one
   * place they are loaded, and it does not go near the network: a folder shows
   * its hosts on the first frame, and syncing is asked for.
   */
  const loadGitFolders = useStore((s) => s.loadGitFolders)
  // Needed from the Inventory tab too, where the collections section is not on
  // screen but the selection bar still offers to add hosts to an existing one.
  const loadCollections = useStore((s) => s.loadCollections)
  const loadMultiWindows = useStore((s) => s.loadMultiWindows)
  // Wanted by the host menus in both trees, so they are here rather than read
  // when a menu opens: a menu that has to wait on a round trip cannot list them.
  const loadCredentials = useStore((s) => s.loadCredentials)

  useShortcuts({
    openSnippets: () => setPaletteOpen(true),
    openHelp: () => setHelpOpen(true),
    openHosts: () => setHostsOpen(true)
  })
  useIdleLock()
  useZoom()

  useEffect(() => {
    loadSnippets()
    loadInventory()
    loadGitFolders()
    loadCollections()
    loadMultiWindows()
    loadCredentials()
  }, [
    loadSnippets,
    loadInventory,
    loadGitFolders,
    loadCollections,
    loadMultiWindows,
    loadCredentials
  ])

  return (
    <div className="app-root">
      <UpdateBanner />
      <WhatsNewBanner />
      <div className="app-shell">
        <Sidebar onOpenSnippets={() => setPaletteOpen(true)} onOpenHelp={() => setHelpOpen(true)} />
        <Workspace />
      </div>
      {paletteOpen && <SnippetPalette onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {hostsOpen && <HostPalette onClose={() => setHostsOpen(false)} />}
      {/* One at a time, each after the last is closed. Keyed so the next
          starts with its own query rather than the last one's. */}
      {!hostsOpen && launchAsks.length > 0 && (
        <HostPalette
          key={`${launchAsks.length}:${launchAsks[0].query}`}
          request={launchAsks[0]}
          onClose={() => setLaunchAsks((asks) => asks.slice(1))}
        />
      )}
      <AuthPromptDialog />
    </div>
  )
}
