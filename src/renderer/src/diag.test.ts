import { describe, it, expect } from 'vitest'
import { heldForJournal } from './diag'

/* A letter held while a modifier went down was written by its physical key. */
describe('the keys a desktop holds, in the journal', () => {
  it('names the modifiers and no other key', () => {
    expect(heldForJournal(['ShiftLeft', 'KeyQ', 'AltRight', 'Digit2'])).toBe('ShiftLeft,AltRight')
    expect(heldForJournal(['KeyQ'])).toBe('-')
  })
})
