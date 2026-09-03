import { describe, expect, it } from 'vitest'
import { modifierFixes, type ModifierState } from './modifierSync'

/** A keyboard, as the event would report it. */
function keyboard(...pressed: ModifierState[]) {
  return (state: ModifierState): boolean => pressed.includes(state)
}

describe('modifierFixes', () => {
  it('says nothing when both ends agree', () => {
    expect(
      modifierFixes({
        held: new Set(['ControlLeft']),
        down: keyboard('Control'),
        commandAsControl: false
      })
    ).toEqual([])
  })

  it('releases a modifier the far end holds and this keyboard does not', () => {
    expect(
      modifierFixes({
        held: new Set(['ControlLeft', 'ShiftRight']),
        down: keyboard('Shift'),
        commandAsControl: false
      })
    ).toEqual([{ code: 'ControlLeft', down: false }])
  })

  it('releases both sides, since the state cannot tell them apart', () => {
    expect(
      modifierFixes({
        held: new Set(['ControlLeft', 'ControlRight']),
        down: keyboard(),
        commandAsControl: false
      })
    ).toEqual([
      { code: 'ControlLeft', down: false },
      { code: 'ControlRight', down: false }
    ])
  })

  it('presses a modifier this keyboard holds and the far end does not', () => {
    // What a blur leaves behind: everything was released over there while the
    // hand never left the key, so the first Ctrl-click afterwards was a plain
    // click.
    expect(
      modifierFixes({ held: new Set(), down: keyboard('Control'), commandAsControl: false })
    ).toEqual([{ code: 'ControlLeft', down: true }])
  })

  it('leaves the key the event is about to the handler that owns it', () => {
    expect(
      modifierFixes({
        held: new Set(),
        down: keyboard('Control'),
        commandAsControl: false,
        ignore: 'ControlLeft'
      })
    ).toEqual([])
  })

  it('does not press anything while a release is being processed', () => {
    expect(
      modifierFixes({
        held: new Set(),
        down: keyboard('Alt'),
        commandAsControl: false,
        press: false
      })
    ).toEqual([])
  })

  it('keeps the side already held rather than adding the other one', () => {
    expect(
      modifierFixes({
        held: new Set(['ControlRight']),
        down: keyboard('Control'),
        commandAsControl: false
      })
    ).toEqual([])
  })
})

describe('modifierFixes with ⌘ standing in for Ctrl', () => {
  it('keeps the Ctrl that ⌘ pressed while ⌘ is still down', () => {
    // The regression this was written for: `Control` is false while ⌘ alone is
    // held, so checking it released the Ctrl the substitution had just sent and
    // ⌘C arrived on the far side as a bare `c`.
    expect(
      modifierFixes({
        held: new Set(['ControlLeft']),
        down: keyboard('Meta'),
        commandAsControl: true,
        ignore: 'KeyC'
      })
    ).toEqual([])
  })

  it('keeps Ctrl held while the hand moves from ⌘ to the real Ctrl', () => {
    expect(
      modifierFixes({
        held: new Set(['ControlLeft']),
        down: keyboard('Control'),
        commandAsControl: true
      })
    ).toEqual([])
  })

  it('releases Ctrl once both ⌘ and Ctrl are up', () => {
    expect(
      modifierFixes({ held: new Set(['ControlLeft']), down: keyboard(), commandAsControl: true })
    ).toEqual([{ code: 'ControlLeft', down: false }])
  })

  it('never sends Meta while the substitution is on', () => {
    expect(
      modifierFixes({ held: new Set(), down: keyboard('Meta'), commandAsControl: true })
    ).toEqual([{ code: 'ControlLeft', down: true }])
  })

  it('sends Meta when the substitution is off', () => {
    expect(
      modifierFixes({ held: new Set(), down: keyboard('Meta'), commandAsControl: false })
    ).toEqual([{ code: 'MetaLeft', down: true }])
  })
})
