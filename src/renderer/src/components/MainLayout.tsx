import Sidebar from './Sidebar'
import Workspace from './Workspace'
import { useShortcuts, useIdleLock } from '../hooks/useShortcuts'

export default function MainLayout(): JSX.Element {
  useShortcuts()
  useIdleLock()

  return (
    <div className="app-shell">
      <Sidebar />
      <Workspace />
    </div>
  )
}
