import Sidebar from './Sidebar'
import Workspace from './Workspace'

export default function MainLayout(): JSX.Element {
  return (
    <div className="app-shell">
      <Sidebar />
      <Workspace />
    </div>
  )
}
