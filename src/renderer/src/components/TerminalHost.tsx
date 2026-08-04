import { useEffect, useRef } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import type { PaneTarget } from '../state/store'

interface Props {
  target: PaneTarget
  connectionId?: string
  onConnected: (connectionId: string) => void
  onFocus: () => void
}

export default function TerminalHost({ target, connectionId, onConnected, onFocus }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connIdRef = useRef<string | undefined>(connectionId)

  useEffect(() => {
    if (!hostRef.current) return
    const term = new Terminal({
      convertEol: true,
      fontFamily: 'Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#17181c', foreground: '#e4e6eb' },
      cursorBlink: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    let disposed = false
    let offData: (() => void) | undefined
    let offStatus: (() => void) | undefined
    let offError: (() => void) | undefined

    term.onData((data) => {
      if (connIdRef.current) window.td.ssh.write(connIdRef.current, data)
    })

    async function connect(): Promise<void> {
      term.writeln(`Connecting...\r\n`)
      try {
        const { cols, rows } = term
        const result =
          target.kind === 'session'
            ? await window.td.ssh.connect(target.sessionId, cols, rows)
            : await window.td.ssh.quickConnect(target.params, cols, rows)
        if (disposed) return
        connIdRef.current = result.connectionId
        onConnected(result.connectionId)

        offData = window.td.ssh.onData(result.connectionId, (b64) => {
          term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
        })
        offStatus = window.td.ssh.onStatus(result.connectionId, (status) => {
          if (status === 'closed') term.writeln('\r\n\x1b[31m[connection closed]\x1b[0m')
        })
        offError = window.td.ssh.onError(result.connectionId, (message) => {
          term.writeln(`\r\n\x1b[31m[error] ${message}\x1b[0m`)
        })
      } catch (err) {
        term.writeln(`\r\n\x1b[31m[failed to connect] ${(err as Error).message}\x1b[0m`)
      }
    }

    if (connIdRef.current) {
      offData = window.td.ssh.onData(connIdRef.current, (b64) => {
        term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
      })
    } else {
      connect()
    }

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      if (connIdRef.current) window.td.ssh.resize(connIdRef.current, term.cols, term.rows)
    })
    resizeObserver.observe(hostRef.current)

    return () => {
      disposed = true
      offData?.()
      offStatus?.()
      offError?.()
      resizeObserver.disconnect()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div className="terminal-host" ref={hostRef} onClick={onFocus} />
}
