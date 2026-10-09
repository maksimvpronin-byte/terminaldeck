import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { PaneTarget } from '../state/store'
import { useStore } from '../state/store'
import { MIN_CONTRAST_RATIO, themeOf } from '../state/settings'
import { useAppearance } from '../hooks/useAppearance'
import ContextMenu, { type MenuItem } from './ContextMenu'
import { IS_MAC } from '../state/keys'
import { translate, useT } from '../i18n'
import { diag, diagKey } from '../diag'

interface Props {
  target: PaneTarget
  /** The collection this pane was opened from, if any — it lends its look. */
  viaCollectionId?: string
  connectionId?: string
  active: boolean
  /** Restored from a saved layout, so it starts idle rather than connecting. */
  restored?: boolean
  /**
   * The live session, and undefined once it has closed — the same as a desktop
   * pane says it. The host tree marks a host as open, broadcast types into it,
   * and the file panel talks to it on the strength of this id, and a session
   * that had ended went on counting as all three.
   */
  onConnected: (connectionId: string | undefined) => void
  onFocus: () => void
  /** Called when output arrives, so a background tab can be flagged. */
  onOutput?: () => void
  /** Returns every connection that should receive this pane's keystrokes. */
  resolveWriteTargets: (ownConnectionId: string) => string[]
  /**
   * Bumped when the host was opened again and this pane was brought forward
   * instead: if it is not connected, it connects, as its button would.
   */
  wake?: number
  /** The wake asks a connected pane to reconnect as well. */
  wakeReconnect?: boolean
}

/**
 * Draws through the GPU instead of the DOM.
 *
 * xterm's default renderer builds an element per cell, which is the slowest
 * path it offers and shows on anything that scrolls — a build log, `tail -f`,
 * a full-screen editor redrawing itself.
 *
 * Must come after `term.open`: the addon needs a canvas to attach to, and
 * throws without one. Failure is not worth reporting to anyone — a machine
 * with no working WebGL keeps the renderer it has always had, which is exactly
 * what shipped before this.
 */
function enableGpuRenderer(term: Terminal): void {
  try {
    const webgl = new WebglAddon()
    // A context can be lost on waking from sleep, on a driver reset, or on the
    // window being dragged to a display driven by another GPU. The addon does
    // not recover by itself; disposing it puts the DOM renderer back, which
    // draws rather than leaving a dead canvas on screen.
    webgl.onContextLoss(() => webgl.dispose())
    term.loadAddon(webgl)
  } catch {
    /* no WebGL here; the DOM renderer stays */
  }
}

export default function TerminalHost({
  target,
  viaCollectionId,
  connectionId,
  active,
  restored,
  onConnected,
  onFocus,
  onOutput,
  resolveWriteTargets,
  wake = 0,
  wakeReconnect = false
}: Props): JSX.Element {
  const t = useT()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  // Takes back the window listener a press left waiting for its release.
  const releaseRef = useRef<(() => void) | null>(null)
  const connIdRef = useRef<string | undefined>(connectionId)
  const unsubscribeRef = useRef<Array<() => void>>([])
  /** Bumped on every mount/unmount so stale in-flight connects can be discarded. */
  const generationRef = useRef(0)
  /** The connect in flight, if any, by the id the main process knows it under. */
  const attemptRef = useRef<string | null>(null)

  // Kept in refs so `connect` can stay referentially stable across renders.
  const targetRef = useRef(target)
  targetRef.current = target
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected
  const resolveWriteTargetsRef = useRef(resolveWriteTargets)
  resolveWriteTargetsRef.current = resolveWriteTargets
  const onOutputRef = useRef(onOutput)
  onOutputRef.current = onOutput

  // Behaviour stays application-wide; only the look is per host.
  const settings = useStore((s) => s.settings)
  const appearance = useAppearance(target, viaCollectionId)
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance

  const [closed, setClosed] = useState(false)
  const closedRef = useRef(closed)
  closedRef.current = closed
  const [searchOpen, setSearchOpen] = useState(false)
  const [needle, setNeedle] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const detachListeners = useCallback(() => {
    for (const off of unsubscribeRef.current) off()
    unsubscribeRef.current = []
  }, [])

  const attachListeners = useCallback((cid: string) => {
    const term = termRef.current
    if (!term) return
    unsubscribeRef.current.push(
      window.td.ssh.onData(cid, (data) => {
        // The acknowledgement is not bookkeeping: the main process pauses the
        // connection when too much output is outstanding, and this is what
        // starts it again. xterm calls back once the chunk has been parsed,
        // which is the moment this end is genuinely ready for more.
        term.write(data, () => window.td.ssh.ack(cid, data.length))
        onOutputRef.current?.()
      }),
      window.td.ssh.onStatus(cid, (status) => {
        diag('terminal', `${cid.slice(0, 8)} status ${status}`)
        if (status === 'closed') {
          term.writeln('\r\n\x1b[31m[connection closed]\x1b[0m')
          setClosed(true)
          onConnectedRef.current(undefined)
        }
      }),
      window.td.ssh.onError(cid, (message) => {
        term.writeln(`\r\n\x1b[31m[error] ${message}\x1b[0m`)
      })
    )
  }, [])

  const connect = useCallback(
    async (generation: number) => {
      const term = termRef.current
      if (!term) return
      detachListeners()
      setClosed(false)
      // Not t(): connect keeps one identity across renders, and t is new on each.
      term.writeln(`${translate(useStore.getState().settings.language, 'Connecting…')}\r\n`)
      const attemptId = crypto.randomUUID()
      attemptRef.current = attemptId
      try {
        const { cols, rows } = term
        const tgt = targetRef.current
        const result =
          tgt.kind === 'session'
            ? // The account travels with the pane, so a reconnect signs in as
              // whoever this pane was opened as rather than reverting to the
              // host's own login.
              await window.td.ssh.connect(tgt.sessionId, cols, rows, tgt.credentialId, attemptId)
            : await window.td.ssh.quickConnect(tgt.params, cols, rows, attemptId)
        // The pane was torn down (or reconnected) while we were connecting — React
        // remounts effects in StrictMode, so without this both attempts would end up
        // feeding the same terminal from two separate SSH sessions.
        if (generationRef.current !== generation) {
          window.td.ssh.disconnect(result.connectionId)
          return
        }
        connIdRef.current = result.connectionId
        onConnectedRef.current(result.connectionId)
        attachListeners(result.connectionId)
        /*
         * Only now. The id is what the channels are named after, so nothing
         * could have been listening before this line — and the main process
         * holds everything it has to say until it hears this, rather than
         * shouting into a room nobody is in yet. The shell's greeting used to
         * go that way now and then; a tunnel that refused to come up went that
         * way every time, since that is reported while `connect` is still
         * working and the id has not come back.
         */
        window.td.ssh.ready(result.connectionId)
      } catch (err) {
        if (generationRef.current !== generation) return
        term.writeln(`\r\n\x1b[31m[failed to connect] ${(err as Error).message}\x1b[0m`)
        setClosed(true)
      } finally {
        if (attemptRef.current === attemptId) attemptRef.current = null
      }
    },
    [attachListeners, detachListeners]
  )

  useEffect(() => {
    if (!hostRef.current) return
    const generation = ++generationRef.current
    const a = appearanceRef.current
    const term = new Terminal({
      convertEol: true,
      fontFamily: a.fontFamily,
      fontSize: a.fontSize,
      theme: themeOf(a),
      minimumContrastRatio: MIN_CONTRAST_RATIO,
      cursorBlink: a.cursorBlink,
      cursorStyle: a.cursorStyle,
      scrollback: a.scrollback
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(hostRef.current)
    enableGpuRenderer(term)
    if (hostRef.current.clientWidth > 0 && hostRef.current.clientHeight > 0) fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    if (active) term.focus()

    term.attachCustomKeyEventHandler((e) => {
      // Modifiers and combinations only, and which session they were for.
      if (e.type === 'keydown' || e.type === 'keyup') {
        diagKey('terminal', e, connIdRef.current?.slice(0, 8) ?? 'no session')
      }
      if (e.type !== 'keydown') return true
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return true
      const key = e.key.toLowerCase()

      /**
       * Search opens on ⌘F, and off a Mac on Ctrl+Shift+F.
       *
       * Ctrl+F is a readline binding — one character forward, the other half of
       * Ctrl+B — and taking it meant it never reached the shell. It used to be
       * taken anyway on Windows and Linux, on the grounds that there was no ⌘
       * and no other way to open search; Ctrl+Shift is that other way, and it
       * is now what the whole application uses there.
       */
      if (key === 'f' && (IS_MAC ? e.metaKey : e.ctrlKey && e.shiftKey)) {
        setSearchOpen(true)
        return false
      }
      // Plain Ctrl+C stays SIGINT; Cmd+C and Ctrl+Shift+C copy the selection.
      if (key === 'c' && (e.metaKey || e.shiftKey) && term.hasSelection()) {
        copySelection('keys')
        return false
      }
      if (key === 'v' && (e.metaKey || e.shiftKey)) {
        paste('keys')
        return false
      }
      return true
    })

    /*
     * A terminal that has lost the keyboard looks exactly like one whose session
     * has stopped answering, so the journal says which of the two it was.
     */
    term.textarea?.addEventListener('focus', () =>
      diag('terminal', `${connIdRef.current?.slice(0, 8) ?? 'no session'} focus`)
    )
    term.textarea?.addEventListener('blur', () =>
      diag('terminal', `${connIdRef.current?.slice(0, 8) ?? 'no session'} blur`)
    )

    term.onData((data) => {
      const own = connIdRef.current
      if (!own) return
      for (const cid of resolveWriteTargetsRef.current(own)) window.td.ssh.write(cid, data)
    })

    if (connIdRef.current) attachListeners(connIdRef.current)
    // A restored pane waits for the user: dialling out to every saved host at
    // launch would be surprising, and the vault may still be locked.
    else if (restored) setClosed(true)
    else connect(generation)

    let resizeFrame = 0
    let lastCols = term.cols
    let lastRows = term.rows
    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      // Skip while the pane is hidden (0x0) — fitting then yields bogus cols/rows.
      if (!box || box.width === 0 || box.height === 0) return
      if (resizeFrame) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        if (!hostRef.current?.clientWidth || !hostRef.current.clientHeight) return
        fit.fit()
        if (term.cols === lastCols && term.rows === lastRows) return
        lastCols = term.cols
        lastRows = term.rows
        if (connIdRef.current) window.td.ssh.resize(connIdRef.current, term.cols, term.rows)
      })
    })
    resizeObserver.observe(hostRef.current)

    return () => {
      // Bumping the counter is the whole point of this cleanup: it is what tells
      // a connect still in flight from this mount to discard the session it gets
      // back. The rule is warning about refs that hold a DOM node, where reading
      // a stale one in cleanup is a bug; this one holds a number that is meant
      // to change, and reading it here is not part of what happens.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generationRef.current++
      detachListeners()
      releaseRef.current?.()
      resizeObserver.disconnect()
      cancelAnimationFrame(resizeFrame)
      term.dispose()
      /*
       * A connect still working is given up on, not merely ignored when it
       * lands. Ignoring it left its password prompt on screen for a pane that
       * no longer existed, and the jump hosts it had signed in to open until
       * somebody answered.
       */
      if (attemptRef.current) window.td.ssh.cancelConnect(attemptRef.current)
      if (connIdRef.current) window.td.ssh.disconnect(connIdRef.current)
    }
    // Builds the terminal once and tears it down once. Every value it reads is
    // either a ref or wanted only as it stood at mount; the ones that must
    // follow later changes — the appearance, the active pane, the font size —
    // have effects of their own below. Listing them here would dispose the
    // terminal and drop the connection to change a colour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `focusRequest` too: a click on the tab or host of the pane already in
  // front leaves `active` as it was, and the focus on whatever was clicked.
  const focusRequest = useStore((s) => s.focusRequest)
  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active, focusRequest])

  // Apply appearance changes to terminals that are already open.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = appearance.fontFamily
    term.options.fontSize = appearance.fontSize
    term.options.theme = themeOf(appearance)
    term.options.cursorBlink = appearance.cursorBlink
    term.options.cursorStyle = appearance.cursorStyle
    term.options.scrollback = appearance.scrollback
    fitRef.current?.fit()
    if (connIdRef.current) window.td.ssh.resize(connIdRef.current, term.cols, term.rows)
  }, [appearance])

  function handleClick(): void {
    onFocus()
    termRef.current?.focus()
  }

  /**
   * Pastes through the terminal rather than around it.
   *
   * The text used to be written straight to the connection, which skipped what
   * xterm does for a paste: wrap it in bracketed-paste markers when the shell
   * has asked for them, and turn line feeds into the carriage returns a
   * terminal sends. Without the markers a shell cannot tell a pasted line from
   * a typed one, so every newline in a multi-line paste ran as a command the
   * moment it arrived — including in every pane a broadcast was typing into.
   * `term.paste` does both and hands the result to `onData`, which is where the
   * broadcast targets are already resolved.
   */
  function paste(how: string): void {
    const text = window.td.clipboard.read()
    if (!connIdRef.current) {
      clipDiag(`paste by ${how}: no session`)
      return
    }
    clipDiag(`paste by ${how}: ${text ? `${text.length} chars` : 'clipboard empty'}`)
    if (text) termRef.current?.paste(text)
  }

  /*
   * Copying and pasting go in the journal, as lengths only — what was copied
   * may be a password. Kept for a selection that, now and then, would not
   * paste anywhere afterwards, or pasted something older.
   */
  function clipDiag(message: string): void {
    diag('clipboard', `${connIdRef.current?.slice(0, 8) ?? 'no session'} ${message}`)
  }

  function copySelection(how: string): void {
    const selection = termRef.current?.getSelection()
    if (!selection) return
    clipDiag(`copy by ${how}: ${selection.length} chars`)
    window.td.clipboard.write(selection)
  }

  /**
   * Copies a selection when the left button that made it is let go — wherever
   * it is let go.
   *
   * It used to be any button let go over the pane. A drag that ended past the
   * pane's edge — on the sidebar, a tab, outside the window — left the text
   * selected and the clipboard as it was, so the next paste brought in the
   * copy before. And the right button counted too: a right click to paste
   * copied whatever was still selected over what had just been copied
   * elsewhere, or on a Mac, where xterm selects the word under a right click,
   * that word — and the paste brought in that instead.
   *
   * Listened for in capture from the window: xterm may stop the events on its
   * own element, as it does for a Shift- or Option-drag over a program that
   * has taken the mouse.
   */
  function copyOnRelease(e: React.MouseEvent): void {
    releaseRef.current?.()
    if (e.button !== 0 || !settings.copyOnSelect) return
    const from = { x: e.clientX, y: e.clientY }
    const onUp = (up: MouseEvent): void => {
      if (up.button !== 0) return
      releaseRef.current?.()
      const term = termRef.current
      if (term?.hasSelection()) {
        copySelection('selecting')
        return
      }
      // A drag that selected nothing: a program holding the mouse, as mc does
      // unless Shift (Option on a Mac) is held, takes the drag for itself.
      if (Math.abs(up.clientX - from.x) + Math.abs(up.clientY - from.y) > 4) {
        clipDiag(`drag selected nothing, mouse ${term?.modes.mouseTrackingMode ?? 'unknown'}`)
      }
    }
    window.addEventListener('mouseup', onUp, true)
    releaseRef.current = () => {
      window.removeEventListener('mouseup', onUp, true)
      releaseRef.current = null
    }
  }

  function terminalMenu(): MenuItem[] {
    const term = termRef.current
    const selection = term?.getSelection() ?? ''
    return [
      { label: t('Copy'), disabled: selection === '', onSelect: () => copySelection('menu') },
      { label: t('Paste'), onSelect: () => paste('menu') },
      { label: t('Select all'), separated: true, onSelect: () => term?.selectAll() },
      { label: t('Find…'), onSelect: () => setSearchOpen(true) },
      { label: t('Clear'), separated: true, onSelect: () => term?.clear() }
    ]
  }

  function closeSearch(): void {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  // Opened again from the tree: a pane that has dropped, or was restored idle,
  // connects; one that is connecting is left as it is, and so is a connected
  // one unless the double-click asked for it to start over.
  // Only a request made while mounted: one left in the store from before
  // would otherwise dial out from a pane that was merely moved.
  const wakeSeen = useRef(wake)
  useEffect(() => {
    if (wake === wakeSeen.current) return
    wakeSeen.current = wake
    if (closedRef.current) {
      void connect(generationRef.current)
      return
    }
    const live = connIdRef.current
    if (!wakeReconnect || !live || attemptRef.current) return
    // Its listeners go first, so the old session's ending is not reported in
    // the middle of the new one starting.
    detachListeners()
    connIdRef.current = undefined
    onConnectedRef.current(undefined)
    window.td.ssh.disconnect(live)
    termRef.current?.writeln('\r\n')
    void connect(generationRef.current)
    // The request is what this answers; `wakeReconnect` is read along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wake, connect])

  return (
    <div className="terminal-wrap">
      {searchOpen && (
        <div className="terminal-search">
          <input
            autoFocus
            value={needle}
            placeholder={t('Find…')}
            onChange={(e) => {
              setNeedle(e.target.value)
              searchRef.current?.findNext(e.target.value, { incremental: true })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
              if (e.key === 'Enter') {
                if (e.shiftKey) searchRef.current?.findPrevious(needle)
                else searchRef.current?.findNext(needle)
              }
            }}
          />
          <button
            title={t('Previous (⇧⏎)')}
            onClick={() => searchRef.current?.findPrevious(needle)}
          >
            ↑
          </button>
          <button title={t('Next (⏎)')} onClick={() => searchRef.current?.findNext(needle)}>
            ↓
          </button>
          <button title={t('Close (Esc)')} onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
      <div
        className="terminal-host"
        ref={hostRef}
        onClick={handleClick}
        onMouseDownCapture={copyOnRelease}
        onContextMenu={(e) => {
          e.preventDefault()
          if (settings.rightClick === 'paste') {
            paste('right click')
            termRef.current?.focus()
          } else {
            setMenu({ x: e.clientX, y: e.clientY })
          }
        }}
      />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={terminalMenu()} onClose={() => setMenu(null)} />
      )}
      {closed && (
        <div className="terminal-reconnect">
          <button className="primary" onClick={() => connect(generationRef.current)}>
            {restored && !connIdRef.current ? t('Connect') : t('Reconnect')}
          </button>
        </div>
      )}
    </div>
  )
}
