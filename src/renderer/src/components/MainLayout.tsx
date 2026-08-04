import Sidebar from './Sidebar'
import Workspace from './Workspace'
import UpdateBanner from './UpdateBanner'
import { useShortcuts, useIdleLock } from '../hooks/useShortcuts'

export default function MainLayout(): JSX.Element {
  useShortcuts()
  useIdleLock()

  return (
    <div className="app-root">
      <UpdateBanner />
      <div className="app-shell">
        <Sidebar />
        <Workspace />
      </div>
    </div>
  )
}
