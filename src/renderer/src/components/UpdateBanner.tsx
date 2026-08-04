import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'

export default function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.td.updates.getState().then(setState)
    return window.td.updates.onState(setState)
  }, [])

  if (dismissed || state.status === 'idle') return null
  // A failed update check is noise, not something to act on.
  if (state.status === 'error') return null

  return (
    <div className="update-banner">
      {state.status === 'available' && (
        <>
          <span>Version {state.version} is available.</span>
          <span className="banner-actions">
            <button className="primary" onClick={() => window.td.updates.download()}>
              Download
            </button>
            <button onClick={() => setDismissed(true)}>Later</button>
          </span>
        </>
      )}
      {state.status === 'downloading' && <span>Downloading update… {state.percent}%</span>}
      {state.status === 'ready' && (
        <>
          <span>Version {state.version} is ready to install.</span>
          <span className="banner-actions">
            <button className="primary" onClick={() => window.td.updates.install()}>
              Restart now
            </button>
            <button onClick={() => setDismissed(true)}>On next quit</button>
          </span>
        </>
      )}
    </div>
  )
}
