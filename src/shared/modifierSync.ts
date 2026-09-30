/**
 * Keeping the far end's modifiers in step with this keyboard's.
 *
 * A desktop session sends each key as a press and a release, so the far machine
 * holds whatever it was last told to hold. Lose one release — the focus moved,
 * the system took the combination, the key was pressed before the pane had the
 * focus — and it holds that modifier for ever: every letter afterwards is a
 * shortcut, and every click is a Ctrl-click.
 *
 * So no attempt is made never to lose one. Every input event carries the truth,
 * because `getModifierState` is on the keyboard *and* the mouse event, and this
 * works out what to send to make the far end agree with it. Two directions,
 * both needed:
 *
 * - held there and not here — the stuck modifier, released;
 * - held here and not there — the modifier that went up on a `blur` while the
 *   hand never left it, pressed, so the first Ctrl-click after coming back is
 *   a Ctrl-click.
 */

export type ModifierState = 'Control' | 'Shift' | 'Alt' | 'Meta'

export interface ModifierFix {
  code: string
  down: boolean
}

/**
 * The pairs, and what each answers to.
 *
 * `⌘ as Ctrl` is why this is not a plain lookup. With it on, a held ⌘ is a held
 * Ctrl on the far side and no Meta at all — and the reconciliation has to say
 * the same thing the substitution does, or the two disagree once per keystroke:
 * the state of `Control` is false while ⌘ alone is down, so a check made
 * against it releases the very Ctrl that ⌘ had just pressed, and the ⌘C the
 * user typed arrives over there as a bare `c`.
 */
/**
 * What ⌘ is being sent as: itself, Ctrl (`⌘ as Ctrl`), or Alt — the last only
 * while ⌘Tab is switching windows over there, where the ⌘ still held here is
 * the Alt that Windows needs held for as long as the switcher is open.
 */
export type CommandAs = 'meta' | 'control' | 'alt'

const PAIRS: Array<{
  left: string
  right: string
  wanted: (down: (state: ModifierState) => boolean, command: CommandAs) => boolean
}> = [
  {
    left: 'ControlLeft',
    right: 'ControlRight',
    wanted: (down, command) => down('Control') || (command === 'control' && down('Meta'))
  },
  { left: 'ShiftLeft', right: 'ShiftRight', wanted: (down) => down('Shift') },
  {
    left: 'AltLeft',
    right: 'AltRight',
    wanted: (down, command) => down('Alt') || (command === 'alt' && down('Meta'))
  },
  // Nothing is sent as Meta while ⌘ stands in for something else; that is the
  // substitution.
  {
    left: 'MetaLeft',
    right: 'MetaRight',
    wanted: (down, command) => command === 'meta' && down('Meta')
  }
]

export function modifierFixes({
  held,
  down,
  commandAsControl,
  commandAsAlt = false,
  ignore,
  press = true
}: {
  /** What this end last told the far end to hold. */
  held: ReadonlySet<string>
  /** `getModifierState` from the event that just arrived. */
  down: (state: ModifierState) => boolean
  commandAsControl: boolean
  /** ⌘Tab is switching windows over there, so ⌘ is Alt for now. */
  commandAsAlt?: boolean
  /**
   * The key this event is about, already substituted. It is left alone: the
   * handler is about to send it itself, and repairing it here would send the
   * same press twice or undo it before it arrives.
   */
  ignore?: string | null
  /**
   * Whether a modifier held here but not there may be pressed. Off for an event
   * that is itself a release, where the state is mid-change.
   */
  press?: boolean
}): ModifierFix[] {
  const fixes: ModifierFix[] = []
  const command: CommandAs = commandAsAlt ? 'alt' : commandAsControl ? 'control' : 'meta'

  for (const pair of PAIRS) {
    const wanted = pair.wanted(down, command)
    const sides = [pair.left, pair.right].filter((code) => held.has(code))

    if (!wanted) {
      // Both sides, and both harmlessly: a key released twice over there is
      // already released, and one release too few is the failure this exists
      // to prevent.
      for (const code of sides) {
        if (code !== ignore) fixes.push({ code, down: false })
      }
      continue
    }

    if (sides.length === 0 && press && pair.left !== ignore && pair.right !== ignore) {
      // Which side is held cannot be told from the state, so the left one
      // stands for the pair — as it does for every client that has to guess.
      fixes.push({ code: pair.left, down: true })
    }
  }

  return fixes
}
