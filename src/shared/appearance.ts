import { inheritanceChain } from './inheritance'
import { isSet } from './overrides'
import type { AppearanceDefaults, ResolvedAppearance, SessionGroup } from './types'

const optedOut = (level: AppearanceDefaults): boolean => level.inheritAppearance === false

/**
 * The lookup order with an optional collection slotted in after the item
 * itself. Opting out still stops everything below, the collection included:
 * "this host stands alone" has to mean alone.
 */
function interposedChain(
  own: AppearanceDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  interposed?: AppearanceDefaults
): AppearanceDefaults[] {
  if (optedOut(own)) return [own]
  const rest = inheritanceChain(own, groupId, groups, optedOut).slice(1)
  return interposed ? [own, interposed, ...rest] : [own, ...rest]
}

function pick<K extends keyof AppearanceDefaults>(
  chain: AppearanceDefaults[],
  key: K
): AppearanceDefaults[K] | undefined {
  // Empty strings count as "not set", so a blank field in the UI inherits.
  for (const level of chain) {
    if (isSet(level[key])) return level[key]
  }
  return undefined
}

function firstDefined<K extends keyof AppearanceDefaults>(
  chain: AppearanceDefaults[],
  key: K
): AppearanceDefaults[K] | undefined {
  for (const level of chain) {
    if (level[key] !== undefined) return level[key]
  }
  return undefined
}

/**
 * Collapses a host's appearance chain into the values xterm is configured with.
 *
 * `globals` is the application-wide setting, which sits below every group and
 * ends the chain — so a host that says nothing, in a group that says nothing,
 * looks exactly as it did before any of this existed.
 */
export function resolveAppearance(
  own: AppearanceDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  globals: ResolvedAppearance,
  /**
   * A level sitting between the item and its groups — a collection the host
   * belongs to. It loses to the host's own settings, so a deliberately marked
   * machine keeps its colour, and beats the groups, so a set can recolour
   * everything in it at once.
   */
  interposed?: AppearanceDefaults
): ResolvedAppearance {
  const chain = interposedChain(own, groupId, groups, interposed)
  return {
    fontFamily: pick(chain, 'fontFamily') ?? globals.fontFamily,
    fontSize: pick(chain, 'fontSize') ?? globals.fontSize,
    themeName: pick(chain, 'themeName') ?? globals.themeName,
    cursorStyle: pick(chain, 'cursorStyle') ?? globals.cursorStyle,
    // A blinking cursor can be legitimately switched off, so it takes the first
    // explicit value rather than the first truthy one.
    cursorBlink: firstDefined(chain, 'cursorBlink') ?? globals.cursorBlink,
    scrollback: pick(chain, 'scrollback') ?? globals.scrollback
  }
}

/**
 * Which group a blank field will actually take its value from, so a dialog can
 * say so instead of leaving the user guessing. Undefined when the value is the
 * item's own, or when nothing above it sets one and the global applies.
 */
export function appearanceInheritedFrom(
  own: AppearanceDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof AppearanceDefaults
): SessionGroup | undefined {
  if (isSet(own[key])) return undefined
  // Skip the item itself; everything after it in the chain is an ancestor group.
  // Collections are deliberately not attributed here: they are not editable
  // from a host's dialog, so naming one would offer nothing to act on.
  for (const level of inheritanceChain(own, groupId, groups, optedOut).slice(1)) {
    if (isSet(level[key])) return level as SessionGroup
  }
  return undefined
}

/**
 * What the item would look like if it set nothing of its own — the value every
 * "Inherit (…)" label in a dialog is describing. Its own opt-out is carried
 * over, because opting out is what decides whether the group is consulted at all.
 */
export function inheritedAppearance(
  own: AppearanceDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  globals: ResolvedAppearance
): ResolvedAppearance {
  return resolveAppearance({ inheritAppearance: own.inheritAppearance }, groupId, groups, globals)
}

/** The group a blank field takes its value from; undefined means the globals. */
export function appearanceSource(
  own: AppearanceDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof AppearanceDefaults
): SessionGroup | undefined {
  return appearanceInheritedFrom({ inheritAppearance: own.inheritAppearance }, groupId, groups, key)
}

/** True when the item sets any appearance of its own, for marking it in the UI. */
export function hasOwnAppearance(own: AppearanceDefaults): boolean {
  return (
    own.inheritAppearance === false ||
    isSet(own.fontFamily) ||
    isSet(own.fontSize) ||
    isSet(own.themeName) ||
    isSet(own.cursorStyle) ||
    own.cursorBlink !== undefined ||
    isSet(own.scrollback)
  )
}
