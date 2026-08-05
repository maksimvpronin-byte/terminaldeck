import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import 'xterm/css/xterm.css'
import type { PaneTarget } from '../state/store'
import { useStore } from '../state/store'
import { themeOf } from '../state/settings'
import ContextMenu, { type MenuItem } from './ContextMenu'

interface Props {
  target: PaneTarget
  connectionId?: string
  active: boolean
  /** Restored from a saved layout, so it starts idle rather than connecting. */
  restored?: boolean
  onConnected: (connectionId: string) => void
  onFocus: () => void
  /** Called when output arrives, so a background tab can be flagged. */
  onOutput?: () => void
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
  restored,
  onConnected,
  onFocus,
  onOutput,
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
  const onOutputRef = useRef(onOutput)
  onOutputRef.current = onOutput

  const settings = useStore((s) => s.settings)

  const [closed, setClosed] = useState(false)
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
      window.td.ssh.onData(cid, (b64) => {
        writeBase64(term, b64)
        onOutputRef.current?.()
      }),
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
    const s = useStore.getState().settings
    const term = new Terminal({
      convertEol: true,
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      theme: themeOf(s),
      cursorBlink: s.cursorBlink,
      cursorStyle: s.cursorStyle,
      scrollback: s.scrollback
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
      if (e.type !== 'keydown') return true
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return true
      const key = e.key.toLowerCase()

      if (key === 'f') {
        setSearchOpen(true)
        return false
      }
      // Plain Ctrl+C stays SIGINT; Cmd+C and Ctrl+Shift+C copy the selection.
      if (key === 'c' && (e.metaKey || e.shiftKey) && term.hasSelection()) {
        copySelection()
        return false
      }
      if (key === 'v' && (e.metaKey || e.shiftKey)) {
        paste()
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
    // A restored pane waits for the user: dialling out to every saved host at
    // launch would be surprising, and the vault may still be locked.
    else if (restored) setClosed(true)
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

  // Apply appearance changes to terminals that are already open.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.theme = themeOf(settings)
    term.options.cursorBlink = settings.cursorBlink
    term.options.cursorStyle = settings.cursorStyle
    term.options.scrollback = settings.scrollback
    fitRef.current?.fit()
    if (connIdRef.current) window.td.ssh.resize(connIdRef.current, term.cols, term.rows)
  }, [settings])

  function handleClick(): void {
    onFocus()
    termRef.current?.focus()
  }

  function paste(): void {
    const text = window.td.clipboard.read()
    const own = connIdRef.current
    if (!text || !own) return
    for (const cid of resolveWriteTargetsRef.current(own)) window.td.ssh.write(cid, text)
  }

  function copySelection(): void {
    const selection = termRef.current?.getSelection()
    if (selection) window.td.clipboard.write(selection)
  }

  function terminalMenu(): MenuItem[] {
    const term = termRef.current
    const selection = term?.getSelection() ?? ''
    return [
      { label: 'Copy', disabled: selection === '', onSelect: copySelection },
      { label: 'Paste', onSelect: paste },
      { label: 'Select all', separated: true, onSelect: () => term?.selectAll() },
      { label: 'Find…', onSelect: () => setSearchOpen(true) },
      { label: 'Clear', separated: true, onSelect: () => term?.clear() }
    ]
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
      <div
        className="terminal-host"
        ref={hostRef}
        onClick={handleClick}
        onMouseUp={() => {
          if (settings.copyOnSelect) copySelection()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          if (settings.rightClick === 'paste') {
            paste()
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
            {restored && !connIdRef.current ? 'Connect' : 'Reconnect'}
          </button>
        </div>
      )}
    </div>
  )
}
