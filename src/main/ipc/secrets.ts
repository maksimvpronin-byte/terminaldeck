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
  field: K
): void {
  const ref = item[field]
  if (ref && vault.status().unlocked) vault.deleteSecret(ref)
  item[field] = undefined
}

/**
 * Stores a typed secret, mints a reference for it if there is none, or drops
 * the stored one when the caller passes null. Undefined leaves it as it was,
 * which is what saving a dialog nobody typed a password into means.
 */
export function applySecret<K extends string>(
  item: Partial<Record<K, string | undefined>>,
  field: K,
  secret: string | null | undefined
): void {
  if (secret === null) forgetSecretAt(item, field)
  else if (secret !== undefined) {
    const ref = item[field] ?? randomUUID()
    item[field] = ref
    vault.setSecret(ref, secret)
  }
}
