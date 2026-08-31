import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'
import { useT } from '../i18n'

export default function UpdateBanner(): JSX.Element | null {
  const t = useT()
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
          <span>{t('Version {version} is available.', { version: state.version })}</span>
          <span className="banner-actions">
            <button className="primary" onClick={() => window.td.updates.download()}>
              {t('Download')}
            </button>
            <button onClick={() => setDismissed(true)}>{t('Later')}</button>
          </span>
        </>
      )}
      {state.status === 'downloading' && (
        <span>{t('Downloading update… {percent}%', { percent: state.percent ?? 0 })}</span>
      )}
      {state.status === 'ready' && (
        <>
          <span>{t('Version {version} is ready to install.', { version: state.version })}</span>
          <span className="banner-actions">
            <button className="primary" onClick={() => window.td.updates.install()}>
              {t('Restart now')}
            </button>
            <button onClick={() => setDismissed(true)}>{t('On next quit')}</button>
          </span>
        </>
      )}
    </div>
  )
}
