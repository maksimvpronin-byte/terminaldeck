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
  }, [loadSnippets, loadInventory])

  return (
    <div className="app-root">
      <UpdateBanner />
      <div className="app-shell">
        <Sidebar
          onOpenSnippets={() => setPaletteOpen(true)}
          onOpenHelp={() => setHelpOpen(true)}
        />
        <Workspace />
      </div>
      {paletteOpen && <SnippetPalette onClose={() => setPaletteOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {hostsOpen && <HostPalette onClose={() => setHostsOpen(false)} />}
      <AuthPromptDialog />
    </div>
  )
}
