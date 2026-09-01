/**
 * What a browser calls a key, and what RDP calls it.
 *
 * `KeyboardEvent.code` names a physical key regardless of the layout printed
 * on it — `KeyD` is the third key of the home row whether that key types "d"
 * or "в" — and RDP carries exactly the same idea, as the PS/2 set 1 make code
 * that keyboard would have sent. So the two line up one to one, and the far
 * end applies its own layout to whatever it is handed. That is why a Russian
 * layout on this side reaches a Russian layout on that side without either end
 * translating letters: neither is sending letters.
 *
 * The high half of the map needs a prefix byte on the wire — the `E0` that
 * separates the arrow keys from the numeric keypad keys they share a code
 * with, and the right-hand Ctrl and Alt from the left. That is what
 * `extended` means here, and it is carried as a flag rather than a byte
 * because [MS-RDPBCGR] carries it as a flag too.
 *
 * Characters that no key produces — anything typed with a compose sequence, a
 * dead key, or an input method — are not here and cannot be: they have no
 * physical key to name. Those go as Unicode instead; see `unicodeKey`.
 */

export interface RdpKey {
  /** The set 1 make code. */
  code: number
  /** Whether it is one of the keys the `E0` prefix distinguishes. */
  extended?: boolean
}

const PLAIN: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  /** The key an ISO keyboard has and an ANSI one does not, beside left shift. */
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEqual: 0x59,
  F13: 0x64,
  F14: 0x65,
  F15: 0x66,
  F16: 0x67,
  F17: 0x68,
  F18: 0x69,
  F19: 0x6a,
  F20: 0x6b,
  F21: 0x6c,
  F22: 0x6d,
  F23: 0x6e,
  F24: 0x76,
  /* The Japanese keys, which share their codes with nothing. */
  KanaMode: 0x70,
  IntlRo: 0x73,
  Convert: 0x79,
  NonConvert: 0x7b,
  IntlYen: 0x7d
}

/**
 * The keys the `E0` prefix tells apart.
 *
 * Every one of these shares its make code with a keypad key, or with the
 * left-hand twin of a modifier. Without the prefix, Home is Numpad7 and the
 * right Alt is the left one — which is not a subtle bug on a keyboard where
 * AltGr types half the alphabet.
 */
const EXTENDED: Record<string, number> = {
  NumpadEnter: 0x1c,
  ControlRight: 0x1d,
  NumpadDivide: 0x35,
  PrintScreen: 0x37,
  AltRight: 0x38,
  Home: 0x47,
  ArrowUp: 0x48,
  PageUp: 0x49,
  ArrowLeft: 0x4b,
  ArrowRight: 0x4d,
  End: 0x4f,
  ArrowDown: 0x50,
  PageDown: 0x51,
  Insert: 0x52,
  Delete: 0x53,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  ContextMenu: 0x5d
}

/** The RDP key for a `KeyboardEvent.code`, or nothing if it has none. */
export function rdpKeyFor(code: string): RdpKey | undefined {
  const plain = PLAIN[code]
  if (plain !== undefined) return { code: plain }
  const extended = EXTENDED[code]
  if (extended !== undefined) return { code: extended, extended: true }
  return undefined
}

/**
 * ⌘ as Ctrl, when the host asked for it.
 *
 * Windows puts copy, paste and nearly everything else on Ctrl; a Mac keyboard
 * puts that muscle memory on ⌘, and RDP faithfully delivers ⌘ as the Windows
 * key — which opens the Start menu instead of copying. Substituting the key
 * before it is turned into a scancode is the whole fix, and it is one line
 * here because this end owns the table.
 *
 * Only the modifier itself is swapped. The letter beside it is already the
 * right letter.
 */
export function substituteCommand(code: string, enabled: boolean): string {
  if (!enabled) return code
  if (code === 'MetaLeft') return 'ControlLeft'
  if (code === 'MetaRight') return 'ControlRight'
  return code
}

/**
 * What a keystroke is worth sending as text rather than as a key.
 *
 * A dead key, a compose sequence or an input method produces a character that
 * no single key on the keyboard makes, so there is no scancode to send. RDP
 * has a second path for exactly this — a Unicode keyboard event — and this is
 * the test for when to take it: a printable character, one code point, from an
 * event whose physical key we could not name.
 *
 * Returns the UTF-16 code unit, which is what the protocol field holds.
 */
export function unicodeKey(key: string): number | undefined {
  if (key.length !== 1) return undefined
  const unit = key.charCodeAt(0)
  // Control characters have keys of their own and must not come this way.
  return unit >= 0x20 && unit !== 0x7f ? unit : undefined
}
