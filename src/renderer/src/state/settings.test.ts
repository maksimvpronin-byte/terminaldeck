import { describe, expect, it } from 'vitest'
import {
  ANSI_PALETTE,
  DEFAULT_SETTINGS,
  OTHER_KEYS,
  TERMINAL_KEYS,
  THEMES,
  terminalDefaults,
  themeOf,
  treeRowHeightOf,
  treeTintOf
} from './settings'

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

/**
 * Full-screen programs such as Midnight Commander pick ANSI blue and cyan for
 * their panels and trust them to carry white text. A theme that repainted them
 * pastel left the file names unreadable.
 */
describe('the ANSI colours', () => {
  it('are the same under every theme', () => {
    for (const themeName of Object.keys(THEMES)) {
      expect(themeOf({ themeName }), themeName).toMatchObject(ANSI_PALETTE)
    }
  })

  it('leave the theme its background and text', () => {
    const theme = themeOf({ themeName: 'Nord' })
    expect(theme.background).toBe(THEMES.Nord.terminal.background)
    expect(theme.foreground).toBe(THEMES.Nord.terminal.foreground)
  })
})

describe('the host tree row height', () => {
  it('is what it always was until changed', () => {
    expect(treeRowHeightOf(DEFAULT_SETTINGS)).toBe(32)
  })
  it('is kept inside the range, whatever was stored', () => {
    expect(treeRowHeightOf({ treeRowHeight: 4 })).toBe(20)
    expect(treeRowHeightOf({ treeRowHeight: 400 })).toBe(40)
    expect(treeRowHeightOf({ treeRowHeight: Number.NaN })).toBe(32)
    expect(treeRowHeightOf({ treeRowHeight: 23.6 })).toBe(24)
  })
})

describe('how coloured rows are painted', () => {
  it('fades from the edge unless the even wash was chosen', () => {
    expect(treeTintOf(DEFAULT_SETTINGS)).toBe('fade')
    expect(treeTintOf({ treeTint: 'flat' })).toBe('flat')
    // A value from some other build is not trusted.
    expect(treeTintOf({ treeTint: 'stripes' as never })).toBe('fade')
  })
})
