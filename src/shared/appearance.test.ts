import { describe, it, expect } from 'vitest'
import {
  appearanceSource,
  hasOwnAppearance,
  inheritedAppearance,
  resolveAppearance
} from './appearance'
import type {
  AppearanceDefaults,
  AuthDefaults,
  ResolvedAppearance,
  SessionGroup
} from './types'

const globals: ResolvedAppearance = {
  fontFamily: 'Menlo, Consolas, monospace',
  fontSize: 13,
  themeName: 'TerminalDeck Dark',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000
}

const groups: SessionGroup[] = [
  { id: 'root', name: 'Infra', parentId: null, fontSize: 15, scrollback: 50000 },
  { id: 'prod', name: 'Prod', parentId: 'root', themeName: 'Dracula', cursorBlink: false },
  { id: 'empty', name: 'Empty', parentId: 'root' },
  { id: 'alone', name: 'Alone', parentId: 'root', inheritAppearance: false, themeName: 'Light' }
]

describe('resolveAppearance', () => {
  it('falls back to the application settings with nothing set anywhere', () => {
    expect(resolveAppearance({}, null, groups, globals)).toEqual(globals)
  })

  it("takes the host's own value first", () => {
    expect(resolveAppearance({ themeName: 'Light' }, 'prod', groups, globals).themeName).toBe(
      'Light'
    )
  })

  it('inherits from the immediate group', () => {
    expect(resolveAppearance({}, 'prod', groups, globals).themeName).toBe('Dracula')
  })

  it('walks up to a grandparent for values the parent does not set', () => {
    expect(resolveAppearance({}, 'prod', groups, globals).fontSize).toBe(15)
  })

  it('passes straight through a group that sets nothing', () => {
    expect(resolveAppearance({}, 'empty', groups, globals).fontSize).toBe(15)
  })

  it('treats an empty theme name as unset, so a blank field inherits', () => {
    expect(resolveAppearance({ themeName: '' }, 'prod', groups, globals).themeName).toBe('Dracula')
  })

  it('lets an explicit false for cursorBlink beat an inherited true', () => {
    expect(resolveAppearance({}, 'prod', groups, globals).cursorBlink).toBe(false)
    expect(resolveAppearance({ cursorBlink: true }, 'prod', groups, globals).cursorBlink).toBe(true)
  })

  it('goes straight to the globals when the host opts out', () => {
    const own = { inheritAppearance: false as const }
    expect(resolveAppearance(own, 'prod', groups, globals).themeName).toBe('TerminalDeck Dark')
    expect(resolveAppearance(own, 'prod', groups, globals).fontSize).toBe(13)
  })

  it('still applies a group that opted out, but stops before its parent', () => {
    const resolved = resolveAppearance({}, 'alone', groups, globals)
    expect(resolved.themeName).toBe('Light')
    // 'root' sets 15, but 'alone' does not reach it.
    expect(resolved.fontSize).toBe(13)
  })

  it('does not hang on a group cycle', () => {
    const cyclic: SessionGroup[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a', fontSize: 20 }
    ]
    expect(resolveAppearance({}, 'a', cyclic, globals).fontSize).toBe(20)
  })

  it('is independent of the credential opt-out', () => {
    // A host can stand alone on credentials and still take the group's colours.
    const own: AppearanceDefaults & AuthDefaults = { inheritAuth: false }
    expect(resolveAppearance(own, 'prod', groups, globals).themeName).toBe('Dracula')
  })
})

describe('inheritedAppearance', () => {
  it("reports what a host would look like without its own values", () => {
    const own = { themeName: 'Light', fontSize: 9 }
    expect(inheritedAppearance(own, 'prod', groups, globals)).toMatchObject({
      themeName: 'Dracula',
      fontSize: 15
    })
  })

  it('honours the opt-out, since that decides whether groups are consulted', () => {
    const own = { inheritAppearance: false as const, themeName: 'Light' }
    expect(inheritedAppearance(own, 'prod', groups, globals).themeName).toBe('TerminalDeck Dark')
  })
})

describe('appearanceSource', () => {
  it('names the group a blank field takes its value from', () => {
    expect(appearanceSource({}, 'prod', groups, 'fontSize')?.name).toBe('Infra')
    expect(appearanceSource({}, 'prod', groups, 'themeName')?.name).toBe('Prod')
  })

  it('is undefined when nothing above sets one and the globals apply', () => {
    expect(appearanceSource({}, 'prod', groups, 'fontFamily')).toBeUndefined()
  })
})

describe('hasOwnAppearance', () => {
  it('is false for a host that customises nothing', () => {
    expect(hasOwnAppearance({})).toBe(false)
    // Credential fields are a separate axis and must not mark it as customised.
    const authOnly: AppearanceDefaults & AuthDefaults = { username: 'root' }
    expect(hasOwnAppearance(authOnly)).toBe(false)
  })

  it('counts a switched-off blink, which is a real choice', () => {
    expect(hasOwnAppearance({ cursorBlink: false })).toBe(true)
  })

  it('counts opting out even with no values of its own', () => {
    expect(hasOwnAppearance({ inheritAppearance: false })).toBe(true)
  })
})

describe('an interposed level, as a collection is', () => {
  const collection: AppearanceDefaults = { themeName: 'Nord', fontSize: 11 }

  it('beats the groups, so a whole set can be recoloured at once', () => {
    // 'prod' sets Dracula, but the collection overrules it.
    expect(resolveAppearance({}, 'prod', groups, globals, collection).themeName).toBe('Nord')
  })

  it("loses to the host's own settings, so a marked machine stays marked", () => {
    const own = { themeName: 'Monokai' }
    expect(resolveAppearance(own, 'prod', groups, globals, collection).themeName).toBe('Monokai')
  })

  it('lets the groups supply what it does not state', () => {
    // The collection says nothing about the cursor, so 'prod' still applies.
    expect(resolveAppearance({}, 'prod', groups, globals, collection).cursorBlink).toBe(false)
  })

  it('falls through to the globals when neither it nor the groups state a value', () => {
    expect(resolveAppearance({}, 'prod', groups, globals, collection).fontFamily).toBe(
      globals.fontFamily
    )
  })

  it('is skipped entirely when the host opts out of inheriting', () => {
    const own = { inheritAppearance: false as const }
    expect(resolveAppearance(own, 'prod', groups, globals, collection).themeName).toBe(
      'TerminalDeck Dark'
    )
    expect(resolveAppearance(own, 'prod', groups, globals, collection).fontSize).toBe(13)
  })

  it('changes nothing when absent', () => {
    expect(resolveAppearance({}, 'prod', groups, globals)).toEqual(
      resolveAppearance({}, 'prod', groups, globals, undefined)
    )
  })
})

describe('two collections claiming the same host', () => {
  // The case that prompted this: opening from the second set must not show the
  // first set's look just because it happens to be listed higher.
  const prod: AppearanceDefaults = { themeName: 'Nord' }
  const databases: AppearanceDefaults = { themeName: 'Monokai' }

  it('shows whichever set was opened, not whichever is first', () => {
    expect(resolveAppearance({}, 'prod', groups, globals, prod).themeName).toBe('Nord')
    expect(resolveAppearance({}, 'prod', groups, globals, databases).themeName).toBe('Monokai')
  })

  it("still lets the host's own setting win over either", () => {
    const own = { themeName: 'Light' }
    expect(resolveAppearance(own, 'prod', groups, globals, prod).themeName).toBe('Light')
    expect(resolveAppearance(own, 'prod', groups, globals, databases).themeName).toBe('Light')
  })
})
