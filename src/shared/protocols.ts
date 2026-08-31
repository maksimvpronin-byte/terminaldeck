/**
 * What a host speaks, and what the app can therefore offer it.
 *
 * Until now every host was an SSH host and the pane could assume a terminal.
 * A graphical session has no shell, so the panels bolted to the terminal —
 * file browser, port forwards, monitoring, broadcast — are not merely unused
 * there, they are meaningless. Nor are the settings behind them: a key file, a
 * jump host, a command typed into a shell, a terminal font. This table is what
 * stops the toolbar and the host dialog offering them, and it is the single
 * place to extend when a protocol is added.
 *
 * A *group* is not asked, and must not be: protocol is not inherited, and one
 * group happily holds a Linux box and a Windows one. Only a host knows.
 */

export type Protocol = 'ssh' | 'rdp'

/**
 * Hosts saved before protocols existed have no field, and every one of them is
 * an SSH host. Absent therefore means SSH — not "inherit", which is what an
 * absent field means everywhere in AuthDefaults. Protocol is deliberately not
 * inheritable: it says what a machine *is*, and a group happily holds both a
 * Linux box and a Windows one.
 */
export const DEFAULT_PROTOCOL: Protocol = 'ssh'

/**
 * Validated rather than trusted: a store written by another version can name a
 * protocol this one has never heard of — `vnc` did exist briefly — and reading
 * it back verbatim would leave a pane dispatching on a value nothing handles.
 */
export function protocolOf(host: { protocol?: Protocol } | null | undefined): Protocol {
  const stated = host?.protocol
  return stated && PROTOCOLS.includes(stated) ? stated : DEFAULT_PROTOCOL
}

export interface ProtocolTraits {
  label: string
  /** Default port, offered when a host does not state one. */
  port: number
  /** Draws a terminal; false means a canvas fed by a remote framebuffer. */
  textual: boolean
  /** The SFTP browser, which needs an SSH connection to ride on. */
  files: boolean
  /** Port forwarding, likewise. */
  tunnels: boolean
  /** The monitoring strip, which runs a shell command on each tick. */
  monitor: boolean
  /** Typing into several sessions at once, which only means anything for a shell. */
  broadcast: boolean
  /**
   * Private keys and an SSH agent, rather than a password and nothing else.
   *
   * RDP authenticates with a password — through CredSSP, but a password — and
   * has no notion of either. Offering them on a Windows host is offering a
   * choice that cannot be honoured.
   */
  keyAuth: boolean
  /**
   * Reached through another saved session, the way `ProxyJump` does it.
   *
   * A desktop goes through an RD Gateway instead, which is its own setting
   * under Desktop; `jumpHostId` is never read on that path.
   */
  jumpHost: boolean
}

const TRAITS: Record<Protocol, ProtocolTraits> = {
  ssh: {
    label: 'SSH',
    port: 22,
    textual: true,
    files: true,
    tunnels: true,
    monitor: true,
    broadcast: true,
    keyAuth: true,
    jumpHost: true
  },
  rdp: {
    label: 'RDP',
    port: 3389,
    textual: false,
    // RDP has drive redirection of its own, but it is the far end's feature and
    // not something this app's SFTP browser can drive.
    files: false,
    tunnels: false,
    monitor: false,
    broadcast: false,
    keyAuth: false,
    jumpHost: false
  }
}

export function traitsOf(protocol: Protocol): ProtocolTraits {
  return TRAITS[protocol] ?? TRAITS[DEFAULT_PROTOCOL]
}

/** Every protocol, in the order they should appear in a menu. */
export const PROTOCOLS: Protocol[] = ['ssh', 'rdp']

/**
 * Whether a graphical protocol is carried for this session.
 *
 * Both RDP and VNC reach the far end through the same proxy, so anything that
 * has to ask "is this a desktop rather than a shell" should ask here rather
 * than listing protocols and falling behind when one is added.
 */
export function isGraphical(protocol: Protocol): boolean {
  return !traitsOf(protocol).textual
}
