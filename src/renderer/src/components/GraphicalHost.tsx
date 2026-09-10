import { useEffect, useRef, useState } from 'react'
import { traitsOf, type Protocol } from '../../../shared/protocols'
import type { RdpView } from '../../../shared/types'
import RemoteScreen, { type ScreenPhase } from './RemoteScreen'
import { useStore } from '../state/store'
import { useT } from '../i18n'

type Phase = { at: 'loading' } | { at: 'choosing' } | { at: 'password' } | ScreenPhase

/**
 * The pane body for a desktop session.
 *
 * It starts a desktop of this pane's own, drawn by `RemoteScreen`, which owns
 * everything about a live session. Joining a session somebody else is already
 * working in used to be the other half of this screen; it was taken out because
 * its picture was never ours to draw — see the release notes.
 *
 * Credentials are not asked for here unless the host has none saved. The client
 * runs in a process of its own and authenticates there, so a stored password
 * goes from the vault straight down a pipe — the previous client signed in
 * inside the window, which forced this app to hand the renderer a secret to use
 * RDP at all. That is no longer true and this component no longer sees one.
 */
export default function GraphicalHost({
  protocol,
  host,
  port,
  sessionId,
  credentialId,
  onMeasured,
  paneVisible
}: {
  protocol: Protocol
  host?: string
  port?: number
  sessionId?: string
  /**
   * A stored account this pane signs in as, in place of the host's own login.
   * Only ever an id: what it stands for is resolved in the main process, and no
   * password reaches this component whichever login is used.
   */
  credentialId?: string
  /**
   * What size was asked for and what came back, handed to the pane to show.
   *
   * It used to be the `title` of the element below, which is a native tooltip —
   * an operating-system window Chromium puts on top of everything. That one
   * got stuck: it is the only title in this application that changes while it
   * is on screen, and it covers a whole desktop rather than a button, so it is
   * displayed for as long as somebody is working in the session. Alt-tab away
   * at the wrong moment and it stayed there, over other people's applications,
   * swallowing every click inside it.
   */
  onMeasured?: (text: string) => void
  /** False while another tab is in front: a pane nobody is looking at is not
   *  sent any pixels until it comes back. */
  paneVisible: boolean
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  const [username, setUsername] = useState('')
  /** Only ever typed, and only when the host has none saved. */
  const [password, setPassword] = useState('')
  /** Whether the host has one saved, which decides whether to ask at all. */
  const [hasStoredPassword, setHasStoredPassword] = useState(false)
  /**
   * What the last attempt used, so "Try again" can repeat it without asking
   * again. A password that came from the vault is never here: this end never
   * received one.
   */
  const lastTyped = useRef<string | undefined>(undefined)
  /**
   * Bumped for each attempt, and used as the screen's key.
   *
   * A retry is a new session, and remounting is how that is said: the component
   * starts one when it mounts and ends it when it goes, so there is no second
   * state machine here that could disagree with the first.
   */
  const [attempt, setAttempt] = useState(0)
  /**
   * Something the host said in passing - see `isRefusal`. Kept rather than
   * shown and forgotten: when a session does end, the host's own remark is
   * usually more use than the generic reason that arrives with the ending.
   */
  const [notice, setNotice] = useState('')
  /**
   * How this host wants its desktop drawn, resolved through the same
   * inheritance chain its login comes from. Held until it arrives rather than
   * defaulted, because connecting at the wrong size and correcting afterwards
   * costs the far end a resolution change on every session.
   */
  const [look, setLook] = useState<RdpView | null>(null)
  /**
   * The size asked for and the size that came back, on the pane's tooltip.
   *
   * A server is free to refuse a size and keep its own, and when it does the
   * picture is fitted to the pane and looks magnified — which from the outside
   * is indistinguishable from asking for the wrong size.
   */
  const [asked, setAsked] = useState('')
  const t = useT()

  const traits = traitsOf(protocol)
  const target = `${host ?? ''}:${port ?? traits.port}`

  /**
   * How this host wants its desktop drawn, re-read whenever that could have
   * changed.
   *
   * Read once, this was a trap worth removing: changing the size settings and
   * saving them did nothing at all to the session already on screen, with no
   * sign of why. Someone then changes the setting again, and again, looking at
   * a picture that was never going to move until the tab was closed.
   *
   * The resolution itself walks the host and every group above it, and the main
   * process does that walk — so the two below are not read here. They are what
   * says the answer may have changed.
   */
  const profile = useStore((s) => s.sessions.find((x) => x.id === sessionId))
  const groups = useStore((s) => s.groups)

  useEffect(() => {
    if (protocol !== 'rdp' || !sessionId) return
    let alive = true

    window.td.rdp
      .settings(sessionId)
      .then((resolved) => {
        if (alive) setLook(resolved)
      })
      .catch(() => {
        // Nothing stated, or a host that has gone. The defaults stand.
        if (alive) setLook(null)
      })

    return () => {
      alive = false
    }
    /* `profile` and `groups` are triggers rather than inputs: what they would
       be read for happens in the main process, and listing them is how this
       learns that a save happened. */
  }, [protocol, sessionId, profile, groups])

  /**
   * Who this host logs in as, and whether it has a password saved.
   *
   * Only whether, and now only whether travels: the answer used to carry the
   * password itself, of which this read one bit — its length — while the client
   * had long since moved its authentication into the main process.
   */
  useEffect(() => {
    if (protocol !== 'rdp' || !sessionId || !host) return
    let alive = true

    window.td.rdp
      .login(sessionId, credentialId)
      .then((stored) => {
        if (!alive) return
        setUsername(stored.username)
        setHasStoredPassword(stored.hasPassword)
        setPhase({ at: 'choosing' })
      })
      .catch((err: Error) => {
        if (alive) setPhase({ at: 'failed', reason: err.message })
      })

    return () => {
      alive = false
    }
  }, [protocol, sessionId, credentialId, host, target])

  /** A new desktop of our own, in this pane. */
  function connectFresh(): void {
    if (hasStoredPassword) start(undefined)
    else setPhase({ at: 'password' })
  }

  function start(typed: string | undefined): void {
    lastTyped.current = typed
    setAttempt((n) => n + 1)
    setNotice('')
    setPhase({ at: 'connecting' })
  }

  if (protocol === 'ssh') {
    return (
      <div className="graphical-host">
        <div className="graphical-overlay">
          <div className="graphical-notice">
            <strong>{t('Not a desktop')}</strong>
          </div>
        </div>
      </div>
    )
  }

  /** Whether a live session should exist at all right now. */
  const running = attempt > 0 && (phase.at === 'connecting' || phase.at === 'connected')

  return (
    <div className="graphical-host">
      {running && sessionId && (
        <RemoteScreen
          visible={paneVisible}
          key={attempt}
          sessionId={sessionId}
          credentialId={credentialId}
          look={look}
          password={lastTyped.current}
          onPhase={setPhase}
          onNotice={setNotice}
          onMeasured={(text) => {
            setAsked(text)
            onMeasured?.(text)
          }}
        />
      )}

      {phase.at !== 'connected' && (
        <div className="graphical-overlay">
          <div className="graphical-notice">
            {phase.at === 'loading' && (
              <>
                <strong>
                  {traits.label} — {host ? target : 'no host'}
                </strong>
                <p className="settings-note">{t('Reading the login for this host.')}</p>
              </>
            )}

            {phase.at === 'choosing' && (
              <>
                <strong>{host ? target : t('no host')}</strong>
                <button className="primary" onClick={connectFresh}>
                  {t('New session')}
                </button>
              </>
            )}

            {phase.at === 'password' && (
              <>
                <strong>
                  {t('Password for')} {username || t('this host')}
                </strong>
                <p className="settings-note">
                  {t(
                    'No password is saved for this host. Save one in its dialog to stop being asked.'
                  )}
                </p>
                <input
                  autoFocus
                  type="password"
                  placeholder={t('Password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && start(password)}
                />
                <button className="primary" onClick={() => start(password)}>
                  {t('Connect')}
                </button>
              </>
            )}

            {phase.at === 'connecting' && (
              <>
                <strong>
                  {t('Connecting to')} {target}
                </strong>
                <p className="settings-note">
                  {t('Negotiating with the server.')} {asked}
                </p>
                {notice && <p className="settings-note">{`${t('The host says')}: ${notice}`}</p>}
              </>
            )}

            {(phase.at === 'failed' || phase.at === 'closed') && (
              <>
                <strong>
                  {phase.at === 'failed' ? t('Could not connect') : t('Session ended')}
                </strong>
                <p className="settings-note">{phase.reason}</p>
                {notice && phase.reason !== notice && (
                  <p className="settings-note">{`${t('The host says')}: ${notice}`}</p>
                )}
                <button
                  onClick={() => {
                    // The stored password is used again without ever being
                    // shown here; only a host with nothing saved is asked.
                    if (hasStoredPassword || lastTyped.current) start(lastTyped.current)
                    else setPhase({ at: 'password' })
                  }}
                >
                  {t('Try again')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export { fullscreenTarget, toggleFullscreen } from './RemoteScreen'
