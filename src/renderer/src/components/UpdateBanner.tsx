import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'
import { confirmAction } from '../confirm'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { collectLeaves } from '../state/paneTree'
import { allRoots } from '../state/workspaces'

/** Terminals and desktops that are connected now, and that a restart ends. */
function liveConnections(): number {
  return allRoots(useStore.getState())
    .flatMap(collectLeaves)
    .filter((leaf) => leaf.connectionId ?? leaf.desktopId).length
}

export default function UpdateBanner(): JSX.Element | null {
  const t = useT()
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.td.updates.getState().then(setState)
    return window.td.updates.onState(setState)
  }, [])

  /**
   * A restart ends every session, so it asks first when there are any — and
   * before the download rather than after it, so that nobody comes back from
   * the kettle to find their shells closed by a question they never saw.
   */
  function restartIsFine(): boolean {
    const open = liveConnections()
    return (
      open === 0 ||
      confirmAction(t('Open connections will close: {count}. Update and restart?', { count: open }))
    )
  }

  /** One button, the whole way: download, then restart into the new version. */
  async function updateAndRestart(): Promise<void> {
    if (!restartIsFine()) return
    try {
      await window.td.updates.download()
    } catch {
      // The error arrives as a state of its own; nothing to install.
      return
    }
    await window.td.updates.install()
  }

  if (dismissed || state.status === 'idle') return null
  // A failed update check is noise, not something to act on.
  if (state.status === 'error') return null

  return (
    <div className="update-banner">
      {state.status === 'available' && (
        <>
          <span>{t('Version {version} is available.', { version: state.version })}</span>
          <span className="banner-actions">
            <button className="primary" onClick={() => void updateAndRestart()}>
              {t('Update and restart')}
            </button>
            <button onClick={() => setDismissed(true)}>{t('Later')}</button>
          </span>
        </>
      )}
      {state.status === 'manual' && (
        <>
          <span>
            {t('Version {version} is out. This build cannot install it over itself.', {
              version: state.version
            })}
          </span>
          <span className="banner-actions">
            <button className="primary" onClick={() => window.td.updates.openPage()}>
              {t('Open the downloads')}
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
            <button
              className="primary"
              onClick={() => {
                if (restartIsFine()) window.td.updates.install()
              }}
            >
              {t('Restart now')}
            </button>
            <button onClick={() => setDismissed(true)}>{t('On next quit')}</button>
          </span>
        </>
      )}
    </div>
  )
}
