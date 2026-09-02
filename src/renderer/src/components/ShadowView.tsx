import { useEffect, useRef, useState } from 'react'
import type { WinSession } from '../../../shared/winSessions'
import { useT } from '../i18n'

/**
 * A shadow session, shown in the pane.
 *
 * Nothing here draws the session. `mstsc` draws it, ShadowHost adopts its
 * window, and this component's only job is to keep saying where that window
 * should be — because Chromium composites none of it and knows nothing about
 * it. The placeholder underneath is what shows through before the window
 * arrives, and behind it if anything goes wrong.
 *
 * That also means the window has to be hidden the moment this pane stops being
 * visible. A window positioned over a tab nobody is looking at would sit on top
 * of whatever replaced it.
 */
export default function ShadowView({
  host,
  session,
  control,
  noPrompt,
  profileId,
  credentialId,
  visible,
  onClose
}: {
  host: string
  session: WinSession
  control: boolean
  noPrompt: boolean
  /** The saved connection, so the viewer can be started as the host's user
   *  rather than as whoever is signed in to this machine. */
  profileId?: string
  /** A stored account to start the viewer as, in place of the host's own. */
  credentialId?: string
  /** False while another tab is in front, or the pane is otherwise hidden. */
  visible: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const areaRef = useRef<HTMLDivElement | null>(null)
  const idRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<'starting' | 'showing' | 'failed' | 'ended'>('starting')
  const [reason, setReason] = useState('')

  useEffect(() => {
    let alive = true
    let stopEvents: (() => void) | undefined

    window.td.rdp
      .shadowStart({ host, sessionId: session.id, control, noPrompt, profileId, credentialId })
      .then((id) => {
        if (!alive) {
          // Unmounted while starting; the host must not be left holding a
          // viewer nobody can see.
          void window.td.rdp.shadowStop(id)
          return
        }
        idRef.current = id
        stopEvents = window.td.rdp.onShadowEvent(id, (p) => {
          if (p.event === 'ready') setPhase('showing')
          else if (p.event === 'ended') setPhase('ended')
          else if (p.event === 'error') {
            setPhase('failed')
            setReason(p.detail ?? 'The viewer failed')
          }
        })
        place()
      })
      .catch((err: Error) => {
        if (alive) {
          setPhase('failed')
          setReason(err.message)
        }
      })

    return () => {
      alive = false
      stopEvents?.()
      if (idRef.current) void window.td.rdp.shadowStop(idRef.current)
      idRef.current = null
    }
    // `place` is redeclared on every render and is deliberately absent: this
    // effect starts and stops a shadow session on the host, and re-running it
    // for a new function identity would tear down a live viewer. What `place`
    // reads are refs, so the closure cannot go stale in a way that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, session.id, control, noPrompt])

  /** Where the window should sit, in the page's own coordinates. */
  function place(): void {
    const id = idRef.current
    const area = areaRef.current
    if (!id || !area) return
    const rect = area.getBoundingClientRect()
    // A pane behind another tab measures as nothing. Sending that would collapse
    // the window into a corner, and the session would come back from the tab
    // switch mispositioned rather than where it was left.
    if (rect.width < 1 || rect.height < 1) return
    window.td.rdp.shadowPlace(id, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    })
  }

  // The pane moves for reasons this component never hears about — a split
  // dragged, the sidebar resized, the window itself moved. Watching the element
  // catches all of them without guessing which.
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const observer = new ResizeObserver(() => place())
    observer.observe(area)
    window.addEventListener('resize', place)
    // The window moving on screen changes nothing about the element, so nothing
    // above fires; polling is the only thing that notices.
    const tick = setInterval(place, 500)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    const id = idRef.current
    if (!id) return
    window.td.rdp.shadowVisible(id, visible)
    if (visible) place()
  }, [visible, phase])

  return (
    <div className="graphical-host">
      <div className="graphical-screen" ref={areaRef} />

      {phase !== 'showing' && (
        <div className="graphical-overlay">
          <div className="graphical-notice">
            {phase === 'starting' && (
              <>
                <strong>
                  Joining {session.user || `session ${session.id}`} on {host}
                </strong>
                <p className="settings-note">
                  {noPrompt
                    ? 'Waiting for the host to allow it.'
                    : 'Waiting for the person there to allow it.'}
                </p>
                <button onClick={onClose}>{t('Cancel')}</button>
              </>
            )}

            {(phase === 'failed' || phase === 'ended') && (
              <>
                <strong>{phase === 'failed' ? 'Could not join' : 'The session ended'}</strong>
                {reason && <p className="settings-note">{reason}</p>}
                <button onClick={onClose}>{t('Back')}</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
