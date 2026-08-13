import { useEffect, useRef, useState } from 'react'
import '@devolutions/iron-remote-desktop'
import { Backend, init as initRdp } from '@devolutions/iron-remote-desktop-rdp'
import type { UserInteraction } from '@devolutions/iron-remote-desktop'
import { traitsOf, type Protocol } from '../../../shared/protocols'
import { shadowable, type WinSession } from '../../../shared/winSessions'
import ShadowView from './ShadowView'

type Phase =
  | { at: 'loading' }
  | { at: 'choosing' }
  | { at: 'password' }
  | { at: 'connecting' }
  | { at: 'connected' }
  | { at: 'failed'; reason: string }
  | { at: 'closed'; reason: string }

/** What the component hands over once its canvas and WASM are ready. */
interface ReadyDetail {
  irgUserInteraction: UserInteraction
}

/**
 * Loads the WebAssembly module, once for the whole window.
 *
 * Not optional and not merely an optimisation: `init` is what instantiates the
 * module, and because it is the only thing referencing the embedded binary, a
 * build in which nothing calls it drops the entire 4.5 MB payload as unreachable
 * — leaving the JavaScript wrappers in the bundle and nothing underneath them.
 */
let wasmReady: Promise<void> | null = null
function loadRdp(): Promise<void> {
  wasmReady ??= initRdp('warn')
  return wasmReady
}

/**
 * The pane body for a desktop session.
 *
 * IronRDP's client will not dial an RDP server directly — a proxy address is a
 * required parameter and it opens that WebSocket itself. So the main process
 * stands up a gateway of its own and hands out a single-use loopback address
 * for each session; see main/rdp/Gateway.ts.
 *
 * Credentials are asked for here rather than read from the vault. Stored secrets
 * never leave the main process in this app, and this client authenticates in the
 * window, so wiring the vault to it would mean breaking that rule — a decision
 * worth taking deliberately rather than as a side effect of adding RDP.
 */
export default function GraphicalHost({
  protocol,
  host,
  port,
  sessionId,
  paneVisible
}: {
  protocol: Protocol
  host?: string
  port?: number
  sessionId?: string
  /** False while another tab is in front: a window over a hidden pane would
   *  sit on top of whatever replaced it. */
  paneVisible: boolean
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<UserInteraction | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  const [username, setUsername] = useState('')
  /** Only ever typed, and only when the host has none saved. */
  const [password, setPassword] = useState('')
  /**
   * What the last attempt used, so "Try again" can repeat it. Held in a ref
   * rather than state: a password that came from the vault has no business
   * being in a value the component renders from.
   */
  const lastUsed = useRef<{ user: string; secret: string } | null>(null)
  /** What the host had saved, kept so the chooser can dial without asking. */
  const [storedPassword, setStoredPassword] = useState('')
  const [sessions, setSessions] = useState<WinSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsProblem, setSessionsProblem] = useState<string | undefined>()
  /**
   * Whether to join without asking the person at the far end.
   *
   * Off by default, because taking someone's screen unannounced should be a
   * decision rather than a default. The host has the final say either way:
   * where its policy does not allow this, asking for it is refused outright
   * rather than quietly downgraded to asking.
   */
  const [skipPrompt, setSkipPrompt] = useState(false)
  /** The session being watched in this pane, once one has been chosen. */
  const [joined, setJoined] = useState<{ session: WinSession; control: boolean } | null>(null)

  const traits = traitsOf(protocol)
  const target = `${host ?? ''}:${port ?? traits.port}`

  /**
   * Builds the client's element by hand rather than in JSX.
   *
   * The protocol backend is an object, so it must be set as a property — an
   * attribute would stringify it — and it must be set *before* the element
   * joins the document, because the component reads it when it connects. React
   * inserts an element and only then runs effects and attaches refs, which is
   * already too late: the component connects without a backend and throws from
   * its own constructor, taking the pane's whole subtree down with it.
   *
   * Between `createElement` and `appendChild` is the one window where the
   * property can be set in time, and JSX cannot express it.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || protocol === 'ssh') return

    const onReady = (event: Event): void => {
      interactionRef.current = (event as CustomEvent<ReadyDetail>).detail.irgUserInteraction
    }

    let element: HTMLElement
    try {
      element = document.createElement('iron-remote-desktop')
      ;(element as unknown as { module: unknown }).module = Backend
      element.setAttribute('scale', 'fit')
      element.className = 'graphical-canvas'
      element.addEventListener('ready', onReady)
      container.appendChild(element)
    } catch (err) {
      setPhase({ at: 'failed', reason: describe(err) })
      return
    }

    return () => {
      element.removeEventListener('ready', onReady)
      // Shut the session down before the element goes, so the client is not
      // left holding a canvas that has left the document.
      try {
        interactionRef.current?.shutdown()
      } catch {
        // Already gone, or never started. Nothing to salvage either way.
      }
      interactionRef.current = null
      element.remove()
    }
  }, [protocol])

  /**
   * Uses what the host already has. The login and password live on the host —
   * or on a group above it — like every other credential in this app, so asking
   * again would be asking twice. A domain goes in the username as `DOMAIN\user`,
   * which is what Windows itself accepts.
   */
  useEffect(() => {
    if (protocol !== 'rdp' || !sessionId || !host) return
    let alive = true

    window.td.rdp
      .credentials(sessionId)
      .then((stored) => {
        if (!alive) return
        setUsername(stored.username)
        setStoredPassword(stored.password)
        setPhase({ at: 'choosing' })
      })
      .catch((err: Error) => {
        if (alive) setPhase({ at: 'failed', reason: err.message })
      })

    // Who is already on the host, asked alongside rather than before: the query
    // goes over RPC and can take seconds or never answer, and a new session
    // must not wait on the optional half of the choice.
    window.td.rdp
      .listSessions(sessionId)
      .then((found) => {
        if (!alive) return
        setSessions(shadowable(found.sessions))
        setSessionsProblem(found.problem)
      })
      .catch(() => {
        if (alive) setSessionsProblem('Could not ask the host who is logged on')
      })
      .finally(() => {
        if (alive) setSessionsLoading(false)
      })

    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, sessionId, host, target])

  /** A new desktop of our own, in this pane. */
  function connectFresh(): void {
    if (storedPassword) void connect(username, storedPassword)
    else setPhase({ at: 'password' })
  }

  /** Someone else's desktop, shown in this pane. */
  function shadow(session: WinSession, control: boolean): void {
    if (!host) return
    setJoined({ session, control })
  }

  async function connect(user: string, secret: string): Promise<void> {
    const interaction = interactionRef.current
    if (!interaction || !host) return
    lastUsed.current = { user, secret }

    setPhase({ at: 'connecting' })
    try {
      await loadRdp()
      // Reserved per attempt: the path is spent once used, so a retry after a
      // failure needs a fresh one.
      const proxyAddress = await window.td.rdp.reserve()
      const config = interaction
        .configBuilder()
        .withDestination(target)
        .withProxyAddress(proxyAddress)
        // The real gateway checks this; ours knows the caller by its one-time
        // path, so the token is only here because the builder demands one.
        .withAuthToken('local')
        .withUsername(user)
        .withPassword(secret)
        // Left empty on purpose: a domain travels in the username as
        // `DOMAIN\user`, the way it does everywhere else in Windows.
        .withServerDomain('')
        .build()

      const session = await interaction.connect(config)

      // The component keeps its screen hidden and translated off-view until
      // told otherwise — its own `run` sets this back to false when the session
      // ends, so nothing but the caller ever turns it on. Without it the
      // session runs perfectly and paints where nobody can see it.
      interaction.setVisibility(true)

      // Copy and paste across the session boundary. Off until asked for, and
      // asked for here rather than in the builder because it is a property of
      // the live session — a failure to enable it must not cost the desktop.
      try {
        interaction.setEnableClipboard(true)
        interaction.setEnableAutoClipboard(true)
      } catch {
        // An older client without the channel; the desktop still works.
      }

      setPhase({ at: 'connected' })

      // Resolves when the far end goes away, which is the session ending
      // normally rather than an error.
      const ended = await session.run()
      setPhase({ at: 'closed', reason: ended.reason() })
    } catch (err) {
      setPhase({ at: 'failed', reason: describe(err) })
    }
  }

  // A joined session takes the pane over entirely: its picture belongs to a
  // window sitting on top, and anything rendered here would be hidden by it.
  if (joined && host) {
    return (
      <ShadowView
        host={host}
        session={joined.session}
        control={joined.control}
        noPrompt={skipPrompt}
        visible={paneVisible}
        onClose={() => setJoined(null)}
      />
    )
  }

  if (protocol === 'ssh') {
    return (
      <div className="graphical-host">
        <div className="graphical-overlay">
          <div className="graphical-notice">
            <strong>Not a desktop</strong>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="graphical-host">
      {/* The client's element is put here by the effect above, and stays for
          every phase: it owns its canvas and the WebAssembly behind it, so
          remounting would throw both away mid-session. React must not manage
          its children, or it would fight the component for them. */}
      <div className="graphical-screen" ref={containerRef} />

      {phase.at !== 'connected' && (
        <div className="graphical-overlay">
          <div className="graphical-notice">
            {phase.at === 'loading' && (
              <>
                <strong>
                  {traits.label} — {host ? target : 'no host'}
                </strong>
                <p className="settings-note">Reading the login for this host.</p>
              </>
            )}

            {phase.at === 'choosing' && (
              <>
                <strong>{host ? target : 'no host'}</strong>
                <button className="primary" onClick={connectFresh}>
                  New session
                </button>

                <div className="session-pick-head">
                  <span>Or join a session already open</span>
                  {sessionsLoading && <span className="settings-note">looking…</span>}
                </div>

                {sessions.length > 0 && (
                  <div className="session-pick-list">
                    {sessions.map((s) => (
                      <div className="session-pick-row" key={s.id}>
                        <span className="session-pick-who">
                          {s.user}
                          <span className="settings-note">
                            {' '}
                            {s.name} · {s.state}
                            {s.current ? ' · you' : ''}
                          </span>
                        </span>
                        <button title="Watch without touching" onClick={() => void shadow(s, false)}>
                          Watch
                        </button>
                        <button
                          title="Watch and take the keyboard and mouse"
                          onClick={() => void shadow(s, true)}
                        >
                          Control
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {!sessionsLoading && sessions.length === 0 && (
                  <p className="settings-note">
                    {sessionsProblem ?? 'Nobody is logged on to that host right now.'}
                  </p>
                )}

                {sessions.length > 0 && (
                  <>
                    <label className="checkbox-row session-pick-quiet">
                      <input
                        type="checkbox"
                        checked={skipPrompt}
                        onChange={(e) => setSkipPrompt(e.target.checked)}
                      />
                      Join without asking the person there
                    </label>
                    <p className="settings-note">
                      A joined session opens in a window of its own — Windows draws it, not this
                      app.{' '}
                      {skipPrompt
                        ? 'The host allows this only where its policy says so; where it does not, the connection is refused rather than falling back to asking.'
                        : 'The person at the far end is asked to allow it.'}
                    </p>
                  </>
                )}
              </>
            )}

            {phase.at === 'password' && (
              <>
                <strong>Password for {username || 'this host'}</strong>
                <p className="settings-note">
                  No password is saved for this host. Save one in its dialog to stop being asked.
                </p>
                <input
                  autoFocus
                  type="password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void connect(username, password)}
                />
                <button className="primary" onClick={() => void connect(username, password)}>
                  Connect
                </button>
              </>
            )}

            {phase.at === 'connecting' && (
              <>
                <strong>Connecting to {target}</strong>
                <p className="settings-note">Negotiating with the server.</p>
              </>
            )}

            {(phase.at === 'failed' || phase.at === 'closed') && (
              <>
                <strong>{phase.at === 'failed' ? 'Could not connect' : 'Session ended'}</strong>
                <p className="settings-note">{phase.reason}</p>
                <button
                  onClick={() => {
                    const previous = lastUsed.current
                    // Repeats the stored password without ever showing it; only
                    // a host with nothing saved falls back to asking again.
                    if (previous) void connect(previous.user, previous.secret)
                    else setPhase({ at: 'password' })
                  }}
                >
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Says what went wrong in the client's own terms.
 *
 * IronRDP raises a structured error whose `kind` separates a wrong password
 * from a host that could not be reached — worth keeping, because "failed" alone
 * sends people to check the wrong thing.
 */
function describe(err: unknown): string {
  const KINDS = [
    'General failure',
    'Wrong password',
    'Logon failure',
    'Access denied',
    'The gateway rejected the request',
    'Could not reach the host',
    'Negotiation failed'
  ]

  // Every accessor below is a call into WebAssembly, and each can throw on its
  // own — an error object whose memory has already been freed throws on any
  // method. Reading them defensively is the difference between a message and a
  // pane that takes the window down with it.
  const read = <T,>(get: () => T): T | undefined => {
    try {
      return get()
    } catch {
      return undefined
    }
  }

  const iron = err as {
    kind?: () => number
    backtrace?: () => string
    rdcleanpathDetails?: () => { wsaErrorCode?: number; tlsAlertCode?: number } | undefined
  }

  if (typeof iron?.kind === 'function') {
    const label = KINDS[read(() => iron.kind!()) ?? -1] ?? 'Failed'
    const detail = read(() => iron.rdcleanpathDetails?.())
    const parts = [
      detail?.wsaErrorCode ? `socket error ${detail.wsaErrorCode}` : null,
      detail?.tlsAlertCode ? `TLS alert ${detail.tlsAlertCode}` : null,
      read(() => iron.backtrace?.())
    ].filter(Boolean)
    return parts.length > 0 ? `${label} — ${parts.join(' · ')}` : label
  }

  if (err instanceof Error) return err.message
  if (typeof err === 'string' && err) return err

  // Anything else, including the property bags WebAssembly throws, which carry
  // no name, message or stack — the shape React reports as "undefined:
  // undefined". Say *something* rather than losing it.
  const own = read(() => JSON.stringify(err))
  if (own && own !== '{}' && own !== 'null') return own
  return `Unrecognised failure (${Object.prototype.toString.call(err)})`
}
