import { useEffect, useRef, useState } from 'react'
import '@devolutions/iron-remote-desktop'
import {
  Backend,
  displayControl,
  init as initRdp,
  RdpFileTransferProvider,
  type FileInfo
} from '@devolutions/iron-remote-desktop-rdp'
import type { UserInteraction } from '@devolutions/iron-remote-desktop'
import { traitsOf, type Protocol } from '../../../shared/protocols'
import type { RdpView } from '../../../shared/types'
import { shadowable, type WinSession } from '../../../shared/winSessions'
import ShadowView from './ShadowView'
import { useCommandAsControl } from '../hooks/useCommandAsControl'
import { useT } from '../i18n'

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
function loadRdp(verbose: boolean): Promise<void> {
  /**
   * The level is fixed by the first session in the window, because the module
   * is instantiated once. `debug` is what says which codecs and channels were
   * agreed with the host — the one question that cannot be answered from
   * outside the client, and the one that decides whether a slow desktop is
   * something this end can do anything about.
   */
  wasmReady ??= initRdp(verbose ? 'debug' : 'warn')
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
  const transferRef = useRef<RdpFileTransferProvider | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'loading' })
  /** What a transfer is doing, shown over the desktop while it lasts. */
  const [transfer, setTransfer] = useState('')
  /** Files the far side has copied, waiting to be taken or ignored. */
  const [offer, setOffer] = useState<FileInfo[] | null>(null)
  const [username, setUsername] = useState('')
  /** Only ever typed, and only when the host has none saved. */
  const [password, setPassword] = useState('')
  /**
   * What the last attempt used, so "Try again" can repeat it. Held in a ref
   * rather than state: a password that came from the vault has no business
   * being in a value the component renders from.
   */
  const lastUsed = useRef<{ user: string; secret: string } | null>(null)
  /** The address this attempt reserved, so its failure can be looked up. */
  const reserved = useRef<string | null>(null)
  /** What the host had saved, kept so the chooser can dial without asking. */
  const [storedPassword, setStoredPassword] = useState('')
  /**
   * How this host wants its desktop drawn, resolved through the same
   * inheritance chain its login comes from. Held until it arrives rather than
   * defaulted, because connecting at the wrong size and correcting afterwards
   * costs the far end a resolution change on every session.
   */
  const [look, setLook] = useState<RdpView | null>(null)
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
  const t = useT()

  /**
   * How big the desktop should be, in the far end's own pixels.
   *
   * A pinned size is stated as it is. Otherwise the pane decides — measured in
   * CSS points, and multiplied by the screen's density when asked for: a pane
   * 1400 points wide is 2800 pixels on a Retina display, and asking for 1400
   * gets a desktop the screen then magnifies, large and soft. Returns nothing
   * before the pane has a size, which is the case for one frame after a tab is
   * created.
   */
  function desiredSize(): { width: number; height: number } | null {
    if (look?.resolution === 'fixed') {
      return { width: look.desktopWidth, height: look.desktopHeight }
    }
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.width < 1 || rect.height < 1) return null

    /**
     * As many pixels as the screen has, up to what the host is willing to send.
     *
     * The pane is measured in CSS points; a screen may have more pixels than
     * that. Asking for the points gets a desktop the screen magnifies — soft,
     * and everything in it oversized — so the request follows the display
     * instead. Where that would exceed the budget the factor is reduced rather
     * than abandoned: a desktop somewhat larger than the pane still beats one
     * magnified to fit it.
     *
     * The factor is never below 1, so a screen with one pixel per point — every
     * ordinary monitor — asks for exactly the pane, whatever the budget says.
     */
    const density = window.devicePixelRatio || 1
    const budget = (look?.pixelBudget ?? 3.5) * 1_000_000
    const full = rect.width * density * rect.height * density
    const factor = full <= budget ? density : Math.max(1, density * Math.sqrt(budget / full))

    // [MS-RDPEDISP] takes 200 to 8192 pixels and refuses an odd width.
    return {
      width: Math.min(8192, Math.max(200, Math.round(rect.width * factor))) & ~1,
      height: Math.min(8192, Math.max(200, Math.round(rect.height * factor)))
    }
  }

  // Only while a desktop of our own is on screen: a shadowed session is a
  // window Windows draws, and this app's shortcuts should keep working over it.
  useCommandAsControl(containerRef, look?.commandAsControl === true && phase.at === 'connected')

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
      const detail = (event as CustomEvent<ReadyDetail>).detail
      interactionRef.current = detail.irgUserInteraction

      // Files travel over the RDP clipboard, the same way they do for the
      // Windows client: copy on one side and the other is offered them.
      //
      // Turned on here rather than when the element was made, because a custom
      // element has none of its own methods until the document has it — and
      // still before connect, because the extensions this needs are registered
      // while the session is built.
      try {
        const files = new RdpFileTransferProvider()
        ;(detail.irgUserInteraction as unknown as FileTransferHost).enableFileTransfer(files)
        transferRef.current = files
        files.on('files-available', (offered) => setOffer(offered.length > 0 ? offered : null))
        files.on('error', (failure) => setTransfer(describe(failure)))
      } catch (err) {
        // A session without file transfer is still a session; say so quietly
        // rather than refusing to connect at all.
        setTransfer(`Files cannot be transferred: ${describe(err)}`)
      }
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
      try {
        transferRef.current?.dispose()
      } catch {
        // Never connected, or already gone with the session.
      }
      transferRef.current = null
      interactionRef.current = null
      element.remove()
    }
  }, [protocol])

  /**
   * Fetches what the far side has offered, once someone here asks for it.
   *
   * Copying over there only makes a file available; it is not a decision to put
   * anything on this machine. Fetching it the moment the offer arrived meant a
   * save dialog on every Ctrl+C pressed in the session, for files nobody wanted
   * here — so the offer waits until it is taken.
   *
   * One file is saved wherever the dialog says. Several go into one folder,
   * because a dialog per file for a folder full of them is its own nuisance.
   */
  async function fetchOffered(files: RdpFileTransferProvider, offer: FileInfo[]): Promise<void> {
    setOffer(null)
    let folder: string | undefined
    if (offer.length > 1) {
      folder = await window.td.dialogs.pickDirectory()
      if (!folder) return
    }

    for (const [index, file] of offer.entries()) {
      try {
        setTransfer(`Fetching ${file.name}…`)
        const blob = await files.downloadFile(file, index).completion
        const saved = await window.td.dialogs.saveAs(
          file.name,
          new Uint8Array(await blob.arrayBuffer()),
          folder
        )
        if (!saved) return setTransfer('')
        setTransfer(offer.length > 1 ? `Saved ${index + 1} of ${offer.length}` : `Saved ${file.name}`)
      } catch (err) {
        return setTransfer(describe(err))
      }
    }
  }

  /**
   * Offers files dropped on the pane to the far side.
   *
   * Dropping does not send anything: it puts the files on the session's
   * clipboard, and the far side pulls them when someone pastes there. So the
   * notice says what is left to do rather than reporting a transfer — waiting on
   * the completion alone would sit at "sending" until a paste that might never
   * come.
   *
   * The provider walks a dropped folder itself, so a directory goes whole rather
   * than as the one entry the browser hands over.
   */
  async function onDrop(event: React.DragEvent): Promise<void> {
    const files = transferRef.current
    if (!files || protocol !== 'rdp') return
    event.preventDefault()
    try {
      const dropped = await files.handleDrop(event.nativeEvent)
      if (dropped.length === 0) return

      const what = dropped.length === 1 ? dropped[0].name : `${dropped.length} items`
      setTransfer(`${what} — now paste on the remote desktop`)

      // Reported when it happens, if it happens; the notice above is the part
      // that matters, and it stands until the paste replaces it.
      void files
        .uploadFiles(dropped)
        .completion.then(() => setTransfer(`Copied ${what}`))
        .catch((err: unknown) => setTransfer(describe(err)))
    } catch (err) {
      setTransfer(describe(err))
    }
  }

  /**
   * Full screen, with the system keys along with it.
   *
   * This is the only way Alt+Tab can ever reach the far side. The shell takes it
   * before any program sees it, and the one documented exception is a page that
   * is full screen and has asked to hold the keyboard — which is what Keyboard
   * Lock is for. Held, the key arrives as an ordinary keystroke and the session
   * forwards it like any other; nothing else here has to know.
   *
   * The lock is dropped with the screen. Chromium drops it on its own when full
   * screen ends, but a session closed while still in it would otherwise leave
   * this window holding Alt+Tab for the whole desktop.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || protocol !== 'rdp') return

    const keyboard = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void>; unlock(): void } })
      .keyboard
    const target = fullscreenTarget(container)

    function onChange(): void {
      if (document.fullscreenElement === target) {
        // Named rather than blanket: everything else stays with the desktop, so
        // the window cannot swallow keys nobody meant to give it.
        void keyboard?.lock(['AltLeft', 'AltRight', 'Tab', 'Escape', 'MetaLeft', 'MetaRight'])
      } else {
        keyboard?.unlock()
      }
    }

    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      keyboard?.unlock()
    }
  }, [protocol])

  /**
   * The substitutes for keys this machine keeps for itself.
   *
   * Windows takes Ctrl+Alt+Del in the kernel and Alt+Tab in the shell, both
   * before any program sees them — that is the point of the first and the habit
   * of the second. Every Windows client therefore offers stand-ins on keys the
   * system does let through, and these are the ones they all use.
   *
   * Alt+Tab has no stand-in here. Even caught, there would be nothing to send
   * it with: this client exposes a fixed handful of combinations and no way to
   * build another. Alt+Home opens the far side's Start menu instead, which is
   * where switching windows can be done by hand.
   *
   * Each is swallowed rather than passed on, because End and Home on their own
   * mean something to whatever is running over there.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || protocol !== 'rdp') return

    function onKeyDown(event: KeyboardEvent): void {
      // A split can hold two of these; only the one being typed into answers.
      if (!container?.contains(event.target as Node)) return

      if (event.key === 'F11') {
        event.preventDefault()
        event.stopPropagation()
        toggleFullscreen(fullscreenTarget(container))
        return
      }

      if (!event.altKey) return
      const interaction = interactionRef.current
      if (!interaction) return

      const send =
        event.ctrlKey && event.key === 'End'
          ? (): void => interaction.ctrlAltDel()
          : !event.ctrlKey && event.key === 'Home'
            ? (): void => interaction.metaKey()
            : undefined
      if (!send) return

      event.preventDefault()
      event.stopPropagation()
      try {
        send()
      } catch {
        // The session went. Nothing to send it to, and nothing to report.
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [protocol])

  /**
   * Makes the desktop the size of the pane, rather than scaling it into one.
   *
   * The element is told to fit what it is given, which stretches a picture of a
   * fixed size and blurs it. Asking the far end to change resolution instead
   * keeps every pixel its own, and is what a desktop client does when its window
   * is dragged. Only the connected session can do this — a shadowed one belongs
   * to whoever is working in it, and resizing it would resize their screen.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container || protocol !== 'rdp') return
    // A host pinned to a size keeps it: the element scales that picture into
    // whatever the pane is, which is the point of asking for a fixed one.
    if (look?.resolution === 'fixed') return

    let pending: number | undefined
    const send = (): void => {
      const interaction = interactionRef.current
      const size = desiredSize()
      if (!interaction || !size) return
      try {
        interaction.resize(size.width, size.height)
      } catch {
        // The session went while this was in flight. The next one will fit.
      }
    }

    const observer = new ResizeObserver(() => {
      // Dragging a split fires this every frame, and each one is a round trip
      // and a full redraw. The far end only needs the size the drag ended on.
      window.clearTimeout(pending)
      pending = window.setTimeout(send, 250)
    })
    observer.observe(container)
    // The observer says nothing when a session arrives into a pane that has not
    // moved since, which is the common case.
    if (phase.at === 'connected') send()

    /**
     * Dragging the window to a screen of a different density changes how many
     * pixels the pane is worth without changing how many points it measures, so
     * nothing above notices. Left alone, the desktop keeps the size the old
     * screen asked for: too few pixels on the way to a sharper display, too
     * many on the way back.
     */
    let watchDensity: MediaQueryList | null = null
    const onDensity = (): void => {
      watch()
      send()
    }
    const watch = (): void => {
      watchDensity?.removeEventListener('change', onDensity)
      watchDensity = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      watchDensity.addEventListener('change', onDensity)
    }
    watch()

    return () => {
      observer.disconnect()
      watchDensity?.removeEventListener('change', onDensity)
      window.clearTimeout(pending)
    }
  }, [protocol, phase.at, look?.resolution, look?.pixelBudget])

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
      .settings(sessionId)
      .then((resolved) => {
        if (alive) setLook(resolved)
      })
      .catch(() => {
        // Nothing stated, or a host that has gone. The defaults below stand.
        if (alive) setLook(null)
      })

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
      await loadRdp(await window.td.rdp.tracing().catch(() => false))
      // Reserved per attempt: the path is spent once used, so a retry after a
      // failure needs a fresh one.
      const proxyAddress = await window.td.rdp.reserve(sessionId)
      reserved.current = proxyAddress
      const builder = interaction.configBuilder()

      /**
       * Without this the desktop cannot be resized after it starts.
       *
       * [MS-RDPEDISP] travels on a dynamic virtual channel that has to be asked
       * for while the session is being built; unasked for, `resize` has nowhere
       * to send its request and silently does nothing. The session then keeps
       * whatever size it was given at the start and the element stretches that
       * picture to fill the pane — which looks like a desktop drawn too large
       * and slightly soft, rather than like a feature that is missing.
       */
      builder.withExtension(displayControl(true))

      /**
       * The size to start at, so the first frame is already right.
       *
       * A resize after the fact costs a full redraw and a visible jump, and
       * until one arrives the session is whatever the client defaulted to.
       */
      const startAt = desiredSize()
      if (startAt) builder.withDesktopSize(startAt)
      const config = builder
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
      /**
       * The client's own message is "General failure" for almost anything, and
       * "not enough bytes" when this app's own proxy closed the socket — in
       * both cases the reason lives in the main process. Asked for here rather
       * than pushed, so it belongs to this attempt and no other.
       */
      const explained = reserved.current
        ? await window.td.rdp.failure(reserved.current).catch(() => undefined)
        : undefined
      setPhase({ at: 'failed', reason: explained ?? describe(err) })
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
        profileId={sessionId}
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
            <strong>{t('Not a desktop')}</strong>
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
      <div
        className="graphical-screen"
        ref={containerRef}
        // Dropping a file on a desktop sends it there. Chromium would otherwise
        // navigate the window to the file, taking the session with it.
        onDragOver={(e) => protocol === 'rdp' && e.preventDefault()}
        onDrop={(e) => void onDrop(e)}
      />

      {/* An offer, not an arrival: copying over there put these within reach,
          and nothing comes to this machine until it is asked for. */}
      {offer && (
        <div className="graphical-transfer offer">
          <span>
            {offer.length === 1 ? offer[0].name : `${offer.length} files`} copied over there
          </span>
          <button onClick={() => void fetchOffered(transferRef.current!, offer)}>{t('Save here…')}</button>
          <button className="icon-button" title={t('Ignore')} onClick={() => setOffer(null)}>
            ✕
          </button>
        </div>
      )}

      {!offer && transfer && <div className="graphical-transfer">{transfer}</div>}

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

                <div className="session-pick-head">
                  <span>{t('Or join a session already open')}</span>
                  {sessionsLoading && <span className="settings-note">{t('looking…')}</span>}
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
                          </span>
                        </span>
                        <button title={t('Watch without touching')} onClick={() => void shadow(s, false)}>
                          Watch
                        </button>
                        <button
                          title={t('Watch and take the keyboard and mouse')}
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
                    {sessionsProblem ?? t('Nobody is logged on to that host right now.')}
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
                      {t('Join without asking the person there')}
                    </label>
                    <p className="settings-note">
                      {t(
                        'A joined session opens in a window of its own — Windows draws it, not this app.'
                      )}{' '}
                      {skipPrompt
                        ? t(
                            'The host allows this only where its policy says so; where it does not, the connection is refused rather than falling back to asking.'
                          )
                        : t('The person at the far end is asked to allow it.')}
                    </p>
                  </>
                )}
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
                  onKeyDown={(e) => e.key === 'Enter' && void connect(username, password)}
                />
                <button className="primary" onClick={() => void connect(username, password)}>
                  {t('Connect')}
                </button>
              </>
            )}

            {phase.at === 'connecting' && (
              <>
                <strong>
                  {t('Connecting to')} {target}
                </strong>
                <p className="settings-note">{t('Negotiating with the server.')}</p>
              </>
            )}

            {(phase.at === 'failed' || phase.at === 'closed') && (
              <>
                <strong>{phase.at === 'failed' ? t('Could not connect') : t('Session ended')}</strong>
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

/**
 * Says what went wrong in the client's own terms.
 *
 * IronRDP raises a structured error whose `kind` separates a wrong password
 * from a host that could not be reached — worth keeping, because "failed" alone
 * sends people to check the wrong thing.
 */
/**
 * What goes full screen: the pane, not the picture inside it.
 *
 * So the toolbar comes along and the way back out stays visible — and so the
 * button there and the F11 here mean the same thing, rather than each claiming
 * the screen for a different element.
 */
/** The one method of the element this component needs and its types omit. */
interface FileTransferHost {
  enableFileTransfer(provider: RdpFileTransferProvider): unknown
}

export function fullscreenTarget(container: Element): Element {
  return container.closest('.pane') ?? container
}

export function toggleFullscreen(target: Element): void {
  if (document.fullscreenElement === target) void document.exitFullscreen()
  else void target.requestFullscreen()
}

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
