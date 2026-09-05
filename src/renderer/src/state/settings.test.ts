import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, OTHER_KEYS, TERMINAL_KEYS, terminalDefaults } from './settings'

/**
 * Which settings the Terminal tab's reset is allowed to touch.
 *
 * It used to hand over every default there is, so resetting a font size also
 * changed the language, forgot the external editor and moved the idle lock —
 * three settings on other tabs, none of them named on the button.
 */
describe('the terminal defaults', () => {
  it('covers the fields that tab edits', () => {
    expect(Object.keys(terminalDefaults()).sort()).toEqual([...TERMINAL_KEYS].sort())
  })

  it('leaves the other tabs alone', () => {
    const reset = terminalDefaults()
    for (const key of OTHER_KEYS) expect(reset).not.toHaveProperty(key)
  })

  it('accounts for every setting there is', () => {
    // So that a setting added later has to be placed on one side or the other
    // rather than quietly inheriting whichever behaviour it happens to get.
    const listed = [...TERMINAL_KEYS, ...OTHER_KEYS].sort()
    expect(listed).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
  })
})
