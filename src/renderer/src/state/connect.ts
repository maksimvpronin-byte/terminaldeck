import type { Credential } from '../../../shared/types'

/**
 * What a tab or pane is called once an account, a number, or both are in play.
 *
 * A pane's name is the only place the choice is visible after the connection is
 * made — the account is not written to the host, so the tree still shows the
 * host as whatever it is saved as, and a window signed in as somebody else
 * would otherwise be indistinguishable from one that is not. Six windows on one
 * host have the same problem for a different reason.
 */
export function paneTitle(name: string, credential?: Credential, index?: number): string {
  const base = credential ? `${name} · ${credential.name}` : name
  return index === undefined ? base : `${base} #${index}`
}
