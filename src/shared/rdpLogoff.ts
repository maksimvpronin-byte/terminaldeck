import { rdpKeyFor } from './rdpScancodes'

/**
 * Signing out of a Windows desktop, from this end of the wire.
 *
 * RDP has no message for it. A client can disconnect, and a disconnected
 * session is kept on the host with everything still running in it — which is
 * the thing this exists to avoid. So the session is asked the way a person at
 * its keyboard would ask: Win+R, `logoff`, Enter.
 *
 * The word goes as Unicode keystrokes rather than scancodes, so the far end's
 * keyboard layout has no say in what arrives: a session left on Russian types
 * `дщпщаа` from the same keys. Win, R and Enter are keys, and they are the same
 * key in every layout.
 *
 * What this cannot know is the state of the desktop. A locked session puts the
 * word in its password box, and a host whose policy removes the Run dialog
 * ignores the keys; neither signs out, and both leave the session as it was.
 */

export type LogoffStep = { send: Record<string, string | number | boolean> } | { wait: number }

/** Long enough for the Run dialog to open on a host that is busy. */
export const RUN_DIALOG_WAIT = 1000
/** Between the word and Enter, so the box has taken all of it. */
export const TYPED_WAIT = 150
/**
 * After Enter, before the pane is closed.
 *
 * Closing stops the client, and the client acts on a stop at once — ahead of
 * any keystrokes still waiting their turn — so the keys have to have gone.
 */
export const SENT_WAIT = 1500

const COMMAND = 'logoff'

function key(code: string, down: boolean): LogoffStep {
  const found = rdpKeyFor(code)
  if (!found) throw new Error(`No RDP key for ${code}`)
  return { send: { a: 'key', code: found.code, down, ext: found.extended === true } }
}

export function logoffSequence(): LogoffStep[] {
  return [
    // Whatever the far end believes is held goes up first: a Ctrl it thinks is
    // down turns Win+R into something else.
    { send: { a: 'focus', flags: 0 } },
    key('MetaLeft', true),
    key('KeyR', true),
    key('KeyR', false),
    key('MetaLeft', false),
    { wait: RUN_DIALOG_WAIT },
    ...[...COMMAND].flatMap((ch): LogoffStep[] => [
      { send: { a: 'unicode', code: ch.charCodeAt(0), down: true } },
      { send: { a: 'unicode', code: ch.charCodeAt(0), down: false } }
    ]),
    { wait: TYPED_WAIT },
    key('Enter', true),
    key('Enter', false),
    { wait: SENT_WAIT }
  ]
}

/**
 * Whether a desktop ended because its Windows session was signed out of.
 *
 * Signing out from inside the session — Start, Sign out, or `logoff` — ends
 * the connection with the host saying why, and a session that is gone has
 * nothing to reconnect to: its pane is closed rather than left showing "Session
 * ended" over a desktop that no longer exists. A disconnect, a timeout or a
 * dropped network keeps its pane, because there the session is still there.
 *
 * `errinfo` is the host's reason as the client received it. `code` is the
 * client's last error, which carries the same reason in the error-info class —
 * until something else fails on the way down and overwrites it — and is read
 * only when `errinfo` did not arrive, from a client built before it was sent.
 */
export const ERRINFO_RPC_INITIATED_LOGOFF = 0x00000002
export const ERRINFO_LOGOFF_BY_USER = 0x0000000c
/** FreeRDP's error-info class, as `MAKE_FREERDP_ERROR(ERRINFO, …)` shifts it. */
const ERRINFO_CLASS = 0x00010000

const SIGNED_OUT = new Set([ERRINFO_LOGOFF_BY_USER, ERRINFO_RPC_INITIATED_LOGOFF])

export function endedBySignOut(errinfo: unknown, code: unknown): boolean {
  if (typeof errinfo === 'number') return SIGNED_OUT.has(errinfo)
  if (typeof code !== 'number') return false
  return (code & 0xffff0000) === ERRINFO_CLASS && SIGNED_OUT.has(code & 0xffff)
}
