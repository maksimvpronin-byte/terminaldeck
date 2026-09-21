/**
 * Keeping the far end's Num Lock, Caps Lock and Scroll Lock in step with this
 * keyboard's.
 *
 * RDP does not send lock states with each key; it sends them once, in a
 * Synchronize event, and the far end keeps whatever it was last told. FreeRDP's
 * focus-in is such an event, and it was being sent with no flags at all — on
 * every click into the pane and every time the window lost focus — which says
 * "every lock is off". Num Lock went off over there each time, and the keypad
 * typed arrows instead of digits.
 *
 * So the state sent is the state this keyboard reports, read from the same
 * `getModifierState` the modifier repair uses, and resent whenever the two
 * stop agreeing.
 */

/** [MS-RDPBCGR] 2.2.8.1.1.3.1.1.5, TS_SYNC_EVENT toggleFlags. */
export const SYNC = {
  scrollLock: 0x01,
  numLock: 0x02,
  capsLock: 0x04
} as const

export type LockState = 'ScrollLock' | 'NumLock' | 'CapsLock'

const LOCK_KEYS = new Set(['ScrollLock', 'NumLock', 'CapsLock'])

/** Whether a `KeyboardEvent.code` is one of the keys whose state this tracks. */
export function isLockKey(code: string): boolean {
  return LOCK_KEYS.has(code)
}

/**
 * The toggle flags for a keyboard, as its events report it.
 *
 * A Mac has no Num Lock: its keypad always types digits, and the browser says
 * the lock is off. Passing that on would turn the far end's keypad into arrows,
 * so on a Mac Num Lock is reported on, which is what the keypad behaves like.
 */
export function lockFlags(down: (state: LockState) => boolean, isMac: boolean): number {
  let flags = 0
  if (down('ScrollLock')) flags |= SYNC.scrollLock
  if (isMac || down('NumLock')) flags |= SYNC.numLock
  if (down('CapsLock')) flags |= SYNC.capsLock
  return flags
}
