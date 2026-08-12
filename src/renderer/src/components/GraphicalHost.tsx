import { traitsOf, type Protocol } from '../../../shared/protocols'

/**
 * The pane body for a desktop session, as opposed to a terminal.
 *
 * The frame and the protocol dispatch are in place; the desktop itself is not
 * carried yet. RDP arrives here through IronRDP compiled to WebAssembly, which
 * opens its own WebSocket to what it believes is a Devolutions Gateway — so the
 * main process has to stand up a local one and relay to the real host.
 */
export default function GraphicalHost({
  protocol,
  host,
  port
}: {
  protocol: Protocol
  host?: string
  port?: number
}): JSX.Element {
  const traits = traitsOf(protocol)
  return (
    <div className="graphical-host">
      <div className="graphical-notice">
        <strong>
          {traits.label} — {host ? `${host}:${port ?? traits.port}` : 'no host'}
        </strong>
        <p className="settings-note">
          The pane knows this is a desktop rather than a shell, but nothing carries the picture
          yet. That is the next piece of work.
        </p>
      </div>
    </div>
  )
}
