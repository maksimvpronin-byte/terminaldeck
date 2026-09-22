import { randomUUID } from 'crypto'
import { vault } from '../vault/Vault'

/**
 * Keeping the vault in step with the things that reference it.
 *
 * A credential is stored under a reference the item carries, so saving one and
 * dropping one are two halves of editing that item — and they are the same two
 * halves for a host, a group and an inventory override, which is why they live
 * here rather than three times over.
 */

/** Every field an item keeps a vault reference in: its own login, and its gateway's. */
export const SECRET_FIELDS = ['secretRef', 'gatewaySecretRef'] as const

/**
 * Drops an item's own credential so it inherits again. Without this a host that
 * once had a password of its own keeps using it forever: the nearest value wins,
 * so moving the host into a group leaves the group's credentials unused.
 *
 * The reference goes even if the vault is locked and the ciphertext cannot be
 * removed right now — an unreferenced secret is unreachable, and leaving the
 * reference behind would keep the old password in use.
 */
export function forgetSecret(item: { secretRef?: string }): void {
  forgetSecretAt(item, 'secretRef')
}

/**
 * The same, for whichever reference is named — a host holds two, its own login
 * and the one its gateway wants, and both have to be droppable.
 */
export function forgetSecretAt<K extends string>(
  item: Partial<Record<K, string | undefined>>,
  field: K,
  /** References something else still holds: dropped from the item, kept in the vault. */
  keep?: Set<string>
): void {
  const ref = item[field]
  if (ref && !keep?.has(ref) && vault.status().unlocked) vault.deleteSecret(ref)
  item[field] = undefined
}

/**
 * Drops the credentials of several items at once, in one write of the vault —
 * for deleting many hosts, where one write each would rewrite the vault as many
 * times. Like forgetSecretAt, nothing is removed while the vault is locked.
 */
export function forgetSecretsAt<K extends string>(
  items: Array<Partial<Record<K, string | undefined>>>,
  fields: K[],
  keep?: Set<string>
): void {
  const refs = [...refsHeldBy(items, fields)].filter((ref) => !keep?.has(ref))
  if (refs.length > 0 && vault.status().unlocked) vault.changeSecrets({}, refs)
}

/** Every vault reference the items hold in the named fields. */
export function refsHeldBy<K extends string>(
  items: Array<Partial<Record<K, string | undefined>>>,
  fields: readonly K[]
): Set<string> {
  const refs = new Set<string>()
  for (const item of items) {
    for (const field of fields) {
      const ref = item[field]
      if (ref) refs.add(ref)
    }
  }
  return refs
}

/**
 * Takes an item off a reference it shares with another, where this save is
 * about to change what is stored there.
 *
 * Two items should never hold one reference, but they could: a duplicated
 * desktop kept the original's gateway password reference. Deleting either
 * then deleted the other's password, and typing a new one into the copy
 * changed the original's. A new secret for a shared reference is stored under
 * a new one; dropping a shared one only unties this item. The secrets are
 * returned as saveWithSecrets should be given them.
 */
export function unshareSecrets(
  item: object,
  secrets: Array<[field: string, secret: string | null | undefined]>,
  heldElsewhere: Set<string>
): Array<[field: string, secret: string | null | undefined]> {
  const refs = item as Record<string, string | undefined>
  return secrets.map(([field, secret]) => {
    const ref = refs[field]
    if (secret === undefined || !ref || !heldElsewhere.has(ref)) return [field, secret]
    refs[field] = undefined
    return [field, secret === null ? undefined : secret]
  })
}

/**
 * Saves an item together with the secrets typed for it, as one change.
 *
 * For each named reference: a string stores it (minting a reference if there is
 * none), null drops the stored one, undefined leaves it as it was — which is
 * what saving a dialog nobody typed a password into means.
 *
 * The secrets used to be changed first and the item saved after, each on its
 * own. A save that then failed — a full disk, a file held by a scanner — left
 * the host as it was, pointing at a password that had just been replaced, or at
 * one that had just been deleted, while the dialog reported the failure as if
 * nothing had happened. Now the vault is written once, the item is saved, and if
 * that save fails the vault is put back as it was before either.
 */
export function saveWithSecrets<T extends object, R>(
  item: T,
  secrets: Array<[field: string, secret: string | null | undefined]>,
  save: (item: T) => R
): R {
  const refs = item as Record<string, string | undefined>
  const set: Record<string, string> = {}
  const remove: string[] = []
  for (const [field, secret] of secrets) {
    if (secret === undefined) continue
    if (secret === null) {
      const ref = refs[field]
      if (ref) remove.push(ref)
      refs[field] = undefined
      continue
    }
    const ref = refs[field] ?? randomUUID()
    refs[field] = ref
    set[ref] = secret
  }

  const touchesVault = Object.keys(set).length > 0 || remove.length > 0
  // Forgetting while locked drops the reference and leaves the ciphertext: an
  // unreferenced secret is unreachable. Storing one while locked is refused by
  // the vault itself, before anything is saved.
  if (!touchesVault || (!vault.isUnlocked() && Object.keys(set).length === 0)) return save(item)

  const before = vault.snapshotSecrets()
  vault.changeSecrets(set, remove)
  try {
    return save(item)
  } catch (err) {
    try {
      vault.restoreSecrets(before)
    } catch (restoreErr) {
      throw new Error(
        `${(err as Error).message} — and the passwords changed with it could not be put back (${(restoreErr as Error).message})`
      )
    }
    throw err
  }
}
