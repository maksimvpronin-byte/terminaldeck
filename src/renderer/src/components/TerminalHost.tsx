import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import 'xterm/css/xterm.css'
import type { PaneTarget } from '../state/store'

interface Props {
  target: PaneTarget
  connectionId?: string
  active: boolean
  onConnected: (connectionId: string) => void
  onFocus: () => void
  /** Returns every connection that should receive this pane's keystrokes. */
  resolveWriteTargets: (ownConnectionId: string) => string[]
}

function writeBase64(term: Terminal, b64: string): void {
  term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

export default function TerminalHost({
  target,
  connectionId,
  active,
  onConnected,
  onFocus,
  resolveWriteTargets
}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const connIdRef = useRef<string | undefined>(connectionId)
  const unsubscribeRef = useRef<Array<() => void>>([])
  /** Bumped on every mount/unmount so stale in-flight connects can be discarded. */
  const generationRef = useRef(0)

  // Kept in refs so `connect` can stay referentially stable across renders.
  const targetRef = useRef(target)
  targetRef.current = target
  const onConnectedRef = useRef(onConnected)
  onConnectedRef.current = onConnected
  const resolveWriteTargetsRef = useRef(resolveWriteTargets)
  resolveWriteTargetsRef.current = resolveWriteTargets

  const [closed, setClosed] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [needle, setNeedle] = useState('')

  const detachListeners = useCallback(() => {
    for (const off of unsubscribeRef.current) off()
    unsubscribeRef.current = []
  }, [])

  const attachListeners = useCallback((cid: string) => {
    const term = termRef.current
    if (!term) return
    unsubscribeRef.current.push(
      window.td.ssh.onData(cid, (b64) => writeBase64(term, b64)),
      window.td.ssh.onStatus(cid, (status) => {
        if (status === 'closed') {
          term.writeln('\r\n\x1b[31m[connection closed]\x1b[0m')
          setClosed(true)
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
      term.writeln('Connecting...\r\n')
      try {
        const { cols, rows } = term
        const tgt = targetRef.current
        const result =
          tgt.kind === 'session'
            ? await window.td.ssh.connect(tgt.sessionId, cols, rows)
            : await window.td.ssh.quickConnect(tgt.params, cols, rows)
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
      } catch (err) {
        if (generationRef.current !== generation) return
        term.writeln(`\r\n\x1b[31m[failed to connect] ${(err as Error).message}\x1b[0m`)
        setClosed(true)
      }
    },
    [attachListeners, detachListeners]
  )

  useEffect(() => {
    if (!hostRef.current) return
    const generation = ++generationRef.current
    const term = new Terminal({
      convertEol: true,
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#17181c', foreground: '#e4e6eb' },
      cursorBlink: true,
      scrollback: 10000
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(hostRef.current)
    if (hostRef.current.clientWidth > 0 && hostRef.current.clientHeight > 0) fit.fit()
    termRef.current = term
    fitRef.current = fit
    searchRef.current = search
    if (active) term.focus()

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        setSearchOpen(true)
        return false
      }
      return true
    })

    term.onData((data) => {
      const own = connIdRef.current
      if (!own) return
      for (const cid of resolveWriteTargetsRef.current(own)) window.td.ssh.write(cid, data)
    })

    if (connIdRef.current) attachListeners(connIdRef.current)
    else connect(generation)

    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      // Skip while the pane is hidden (0x0) — fitting then yields bogus cols/rows.
      if (!box || box.width === 0 || box.height === 0) return
      fit.fit()
      if (connIdRef.current) window.td.ssh.resize(connIdRef.current, term.cols, term.rows)
    })
    resizeObserver.observe(hostRef.current)

    return () => {
      generationRef.current++
      detachListeners()
      resizeObserver.disconnect()
      term.dispose()
      if (connIdRef.current) window.td.ssh.disconnect(connIdRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  function handleClick(): void {
    onFocus()
    termRef.current?.focus()
  }

  function closeSearch(): void {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    termRef.current?.focus()
  }

  return (
    <div className="terminal-wrap">
      {searchOpen && (
        <div className="terminal-search">
          <input
            autoFocus
            value={needle}
            placeholder="Find…"
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
          <button title="Previous (⇧⏎)" onClick={() => searchRef.current?.findPrevious(needle)}>
            ↑
          </button>
          <button title="Next (⏎)" onClick={() => searchRef.current?.findNext(needle)}>
            ↓
          </button>
          <button title="Close (Esc)" onClick={closeSearch}>
            ✕
          </button>
        </div>
      )}
      <div className="terminal-host" ref={hostRef} onClick={handleClick} />
      {closed && (
        <div className="terminal-reconnect">
          <button className="primary" onClick={() => connect(generationRef.current)}>
            Reconnect
          </button>
        </div>
      )}
    </div>
  )
}
