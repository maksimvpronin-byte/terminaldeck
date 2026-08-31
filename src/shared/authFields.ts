import { inheritedFrom, resolveAuth, sourceOf } from './authResolution'
import { isSet, withoutBlanks } from './overrides'
import type { AuthDefaults, AuthMethod, ResolvedAuth, SessionGroup } from './types'

/**
 * What the credential half of an editing dialog needs to know.
 *
 * A host, a group and an inventory override are edited by three different
 * dialogs, and each one has to answer the same questions: what will this
 * connect as, where does each unset field come from, does this item hold a
 * credential of its own, and what happens to it. Answering them three times
 * meant three chances to answer differently — and they did differ, which is
 * how the layering bug below came to light.
 *
 * Kept separate from the component so the rules can be tested without a DOM.
 */
export interface AuthFieldsInput {
  /** The item being edited, as the form currently has it. */
  own: AuthDefaults
  /**
   * Settings that sit under the item's own but above its groups: an inventory
   * host, which a local override is edited on top of. Absent for a saved host
   * or group, which have nothing between them and their groups.
   */
  beneath?: AuthDefaults
  /** The group this item hangs off — a host's group, or a group's parent. */
  parentId: string | null
  groups: SessionGroup[]
  /**
   * The form's pending "forget the credential this item holds". Counted here
   * rather than at save time, so the dialog can say what it would fall back to
   * before anyone commits to it.
   */
  forgetSecret: boolean
}

export interface AuthFieldsState {
  /** What this item would connect with, with the pending forget applied. */
  effective: ResolvedAuth
  /**
   * Which set of credential fields the form should show.
   *
   * The three dialogs spelled this two different ways — `effective.authMethod`
   * in one, `own.authMethod ?? effective.authMethod` in another. They cannot
   * disagree: a method set on the item is what resolution picks anyway. One
   * name now, so the question of which to use stops arising.
   */
  shownMethod: AuthMethod
  /**
   * What the method would be if this item stated none — what the "inherit"
   * option actually offers.
   *
   * Two of the three dialogs named the *current* method there, so an item with
   * a method of its own offered "Inherit (agent)" while agent was its own
   * setting and the group said password. The option described the state it was
   * leaving rather than the one it would move to.
   */
  inheritedMethod: AuthMethod
  /** Whether the item holds a credential of its own, and so can drop it. */
  ownSecret: boolean
  /** The group a field would come from if this item left it unset. */
  inheritedFrom: (key: keyof AuthDefaults) => SessionGroup | undefined
  /**
   * A key file and the passphrase for it resolved from different places — a
   * passphrase left over from password auth, say, silently applied to a group's
   * key. Worth saying out loud; the two are only related by convention.
   */
  splitCredential: boolean
  /** Where each of those two comes from, for saying so. */
  keyFrom: CredentialSource
  passphraseFrom: CredentialSource
}

/** The item itself, a group above it, or nowhere at all. */
export type CredentialSource = 'self' | SessionGroup | undefined

export function authFieldsState({
  own,
  beneath,
  parentId,
  groups,
  forgetSecret
}: AuthFieldsInput): AuthFieldsState {
  const pending = forgetSecret ? { ...own, secretRef: undefined } : own

  /**
   * Blanks are dropped before layering, the way `applyOverride` does it for
   * everything else.
   *
   * A form field cleared back to "inherit" holds `undefined`, and a plain
   * spread would write that over the inventory's value rather than falling back
   * to it — showing the group's setting for a connection that will use the
   * repository's. The main process layers with `applyOverride`, so this must
   * too, or the dialog states one thing and the connection does another.
   */
  const layer = (item: AuthDefaults): AuthDefaults =>
    beneath ? { ...beneath, ...withoutBlanks(item) } : item

  const layered = layer(pending)
  const effective = resolveAuth(layered, parentId, groups)
  const keyFrom = sourceOf(layered, parentId, groups, 'privateKeyPath')
  const passphraseFrom = sourceOf(layered, parentId, groups, 'secretRef')

  return {
    effective,
    shownMethod: effective.authMethod,
    // Dropped from the item's own settings and layered again, rather than
    // struck off the finished layers: handing the method back hands it to
    // whatever sits directly underneath — an inventory host before its groups —
    // and taking it off the merged object would skip that host entirely.
    inheritedMethod: resolveAuth(layer({ ...pending, authMethod: undefined }), parentId, groups)
      .authMethod,
    ownSecret: isSet(own.secretRef),
    inheritedFrom: (key) => inheritedFrom(layered, parentId, groups, key),
    splitCredential:
      effective.authMethod === 'privateKey' &&
      keyFrom !== undefined &&
      passphraseFrom !== undefined &&
      keyFrom !== passphraseFrom,
    keyFrom,
    passphraseFrom
  }
}

/**
 * What to hand the store for a credential: a value to save, `null` to forget
 * the one held, or `undefined` to leave whatever is there alone.
 *
 * Both rules in here were written out separately in each dialog, and one of
 * them only in two of the three.
 */
export function secretToSave(
  shownMethod: AuthMethod,
  forgetSecret: boolean,
  typed: string
): string | null | undefined {
  // Agent authentication has no password and no passphrase, so a value left in
  // the box after switching away from another method is not saved by accident.
  const value = shownMethod === 'agent' ? '' : typed
  // Something typed now beats the forget tick — it is the later answer.
  return value || (forgetSecret ? null : undefined)
}
