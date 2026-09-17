/**
 * What the diagnostics journal is allowed to say about input.
 *
 * The journal exists to answer one kind of question — did the Ctrl+D reach the
 * shell, did the session hear that it ended, was a modifier left down on the
 * far side of a desktop — and none of those needs what was typed. A terminal
 * is where passwords are typed, so text never goes in: a run of printable
 * characters is written as how many there were, and only the control
 * characters, which are the ones these questions are about, are named.
 */

/** At most this many pieces per line, so a large paste stays one short line. */
const MAX_PIECES = 24

/** `^D` for 0x04, `^?` for DEL; the notation a terminal user already reads. */
function caret(code: number): string {
  return code === 0x7f ? '^?' : `^${String.fromCharCode(code + 0x40)}`
}

/**
 * Describes what was written to a session without saying what it was.
 *
 * `"asdasd\x04\r"` becomes `6 chars ^D ^M`. An escape is named and whatever
 * printable run follows it is counted like any other, because Alt+letter
 * arrives as ESC and a letter.
 */
export function describeInput(data: string): string {
  const pieces: string[] = []
  let run = 0
  let total = 0
  const flush = (): void => {
    if (run > 0) pieces.push(`${run} chars`)
    run = 0
  }
  for (const ch of data) {
    total++
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) {
      run++
      continue
    }
    flush()
    pieces.push(code === 0x1b ? 'ESC' : caret(code))
  }
  flush()
  if (pieces.length > MAX_PIECES) {
    return `${pieces.slice(0, MAX_PIECES).join(' ')} … (${total} in all)`
  }
  return pieces.join(' ')
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'CapsLock'
])

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

export interface HeldModifiers {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/** `Ctrl+Shift`, or `-` with nothing held. */
export function describeModifiers(m: HeldModifiers): string {
  const held = [m.ctrl && 'Ctrl', m.shift && 'Shift', m.alt && 'Alt', m.meta && 'Meta'].filter(
    Boolean
  )
  return held.length > 0 ? held.join('+') : '-'
}

/**
 * A key, named only when naming it cannot give away text.
 *
 * Modifiers are always named — they are what goes wrong. Any other key is
 * named only while Ctrl, Alt or Meta is held, which makes it a command rather
 * than a character; a key pressed alone or with Shift alone is just `key`.
 */
export function describeKeyCode(code: string, m: HeldModifiers): string {
  if (isModifierCode(code)) return code
  if (m.ctrl || m.alt || m.meta) return code
  return 'key'
}
