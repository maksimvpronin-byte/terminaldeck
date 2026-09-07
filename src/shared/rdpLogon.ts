/**
 * Whether the host's logon message is a refusal or a remark.
 *
 * A Logon Error Info PDU is named for its worst case and is usually not one.
 * `LOGON_MSG_SESSION_CONTINUE` with a session id is the ordinary "you have been
 * put back into the session you already had here" — sent at logon, before the
 * first frame, by any host that keeps disconnected sessions. Treating every one
 * of these as a failure closed a session that was in the middle of opening.
 *
 * MS-RDPBCGR 2.2.1.13.1.1.1 names the two fields errorNotificationType and
 * errorNotificationData. FreeRDP's callback passes them in the other order and
 * under the other names — its `data` is the spec's type, its `type` is the
 * spec's data — so the parameters here are named for FreeRDP, which is where
 * they come from, and the constants for the spec, which is what they mean.
 */

/** FreeRDP's `data`: what went wrong, if anything did. */
export const LOGON_FAILED_BAD_PASSWORD = 0x00000000
export const LOGON_FAILED_UPDATE_PASSWORD = 0x00000001
export const LOGON_FAILED_OTHER = 0x00000002
/** A warning is a remark with a raised voice; the session carries on. */
export const LOGON_WARNING = 0x00000003

/** FreeRDP's `type`: what the host intends to do about it. */
export const LOGON_MSG_SESSION_BUSY_OPTIONS = 0xfffffff8
export const LOGON_MSG_DISCONNECT_REFUSED = 0xfffffff9
export const LOGON_MSG_NO_PERMISSION = 0xfffffffa
export const LOGON_MSG_BUMP_OPTIONS = 0xfffffffb
export const LOGON_MSG_RECONNECT_OPTIONS = 0xfffffffc
export const LOGON_MSG_SESSION_TERMINATE = 0xfffffffd
export const LOGON_MSG_SESSION_CONTINUE = 0xfffffffe
export const ERROR_CODE_ACCESS_DENIED = 0xffffffff

const REFUSALS = new Set([
  LOGON_FAILED_BAD_PASSWORD,
  LOGON_FAILED_UPDATE_PASSWORD,
  LOGON_FAILED_OTHER
])

const REFUSING_INTENTIONS = new Set([
  LOGON_MSG_DISCONNECT_REFUSED,
  LOGON_MSG_NO_PERMISSION,
  LOGON_MSG_SESSION_TERMINATE,
  ERROR_CODE_ACCESS_DENIED
])

/**
 * `unknown` rather than `number`, because these arrive as JSON from the desktop
 * client. A message whose codes did not survive the trip is treated as a
 * refusal: the reason it carries is more useful than the generic one that
 * follows, and a session the host is refusing ends by itself anyway.
 */
export function isRefusal(data: unknown, type: unknown): boolean {
  if (typeof data !== 'number' || typeof type !== 'number') return true
  if (!Number.isInteger(data) || !Number.isInteger(type)) return true
  return REFUSALS.has(data) || REFUSING_INTENTIONS.has(type)
}
