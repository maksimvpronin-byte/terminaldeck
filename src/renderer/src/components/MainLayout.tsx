import { useEffect, useState } from 'react'
import Sidebar from './Sidebar'
import Workspace from './Workspace'
import UpdateBanner from './UpdateBanner'
import SnippetPalette from './SnippetPalette'
import AuthPromptDialog from './AuthPromptDialog'
import HelpDialog from './HelpDialog'
import HostPalette from './HostPalette'
import { useShortcuts, useIdleLock, useZoom } from '../hooks/useShortcuts'
import { useStore } from '../state/store'

export default function MainLayout(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [hostsOpen, setHostsOpen] = useState(false)
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
    loadCredentials()
  }, [loadSnippets, loadInventory, loadGitFolders, loadCollections, loadCredentials])

  return (
    <div className="app-root">
      <UpdateBanner />
      <div className="app-shell">
        <Sidebar onOpenSnippets={() => setPaletteOpen(true)} onOpenHelp={() => setHelpOpen(true)} />
        <Workspace />
      </div>
      {paletteOpen && <SnippetPalette onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {hostsOpen && <HostPalette onClose={() => setHostsOpen(false)} />}
      <AuthPromptDialog />
    </div>
  )
}
