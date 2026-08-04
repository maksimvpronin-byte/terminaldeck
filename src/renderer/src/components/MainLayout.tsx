import { useEffect, useState } from 'react'
import Sidebar from './Sidebar'
import Workspace from './Workspace'
import UpdateBanner from './UpdateBanner'
import SnippetPalette from './SnippetPalette'
import AuthPromptDialog from './AuthPromptDialog'
import { useShortcuts, useIdleLock } from '../hooks/useShortcuts'
import { useStore } from '../state/store'

export default function MainLayout(): JSX.Element {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const loadSnippets = useStore((s) => s.loadSnippets)

  useShortcuts({ openSnippets: () => setPaletteOpen(true) })
  useIdleLock()

  useEffect(() => {
    loadSnippets()
  }, [loadSnippets])

  return (
    <div className="app-root">
      <UpdateBanner />
      <div className="app-shell">
        <Sidebar onOpenSnippets={() => setPaletteOpen(true)} />
        <Workspace />
      </div>
      {paletteOpen && <SnippetPalette onClose={() => setPaletteOpen(false)} />}
      <AuthPromptDialog />
    </div>
  )
}
