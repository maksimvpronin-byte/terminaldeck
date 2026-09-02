import type { Credential } from '../../../shared/types'
import type { Translate } from '../i18n'
import type { MenuItem } from './ContextMenu'

/**
 * The two rows both host trees add to their right-click menu, and the second
 * menu one of them opens.
 *
 * Written once and shared because a saved host and an inventory host are the
 * same thing to connect to: the tree they came from decides how they are
 * edited, never who you sign in as or how many windows you want. Two copies of
 * this would drift, and the way they would drift is the inventory tree quietly
 * lacking whichever of the two somebody added last.
 *
 * There is no submenu here on purpose. `ContextMenu` has none, and adding one
 * to serve a single caller is more machinery than the second menu costs: a
 * choice made in the first menu simply opens another at the same place, which
 * is what the Collect button in the sidebar has always done.
 */
export interface ConnectMenuOptions {
  t: Translate
  credentials: Credential[]
  /** Opens the host once. `undefined` means the login it is saved with. */
  connectAs: (credentialId: string | undefined) => void
  /** Replaces the open menu with another one, in the same place. */
  showMenu: (items: MenuItem[]) => void
  /** The settings screen where accounts are added and edited. */
  manageAccounts: () => void
  /** The dialog that asks how many windows, and as whom. */
  openMultiConnect: () => void
}

/** How an account reads in a menu: what it is called, and who it signs in as. */
export function describeCredential(credential: Credential): string {
  return credential.username ? `${credential.name} — ${credential.username}` : credential.name
}

/** The accounts on offer, as the menu that opens when "Connect as…" is chosen. */
export function accountItems({
  t,
  credentials,
  connectAs,
  manageAccounts
}: Omit<ConnectMenuOptions, 'showMenu' | 'openMultiConnect'>): MenuItem[] {
  return [
    // First, and always present: the ordinary connection, so opening this menu
    // by mistake has an obvious way back out that is not the Escape key.
    { label: t('Its own saved login'), onSelect: () => connectAs(undefined) },
    ...(credentials.length === 0
      ? [{ label: t('No accounts saved yet'), disabled: true, separated: true, onSelect: () => {} }]
      : credentials.map((credential, i) => ({
          label: describeCredential(credential),
          separated: i === 0,
          onSelect: () => connectAs(credential.id)
        }))),
    { label: t('Manage accounts…'), separated: true, onSelect: manageAccounts }
  ]
}

export function connectMenuItems(options: ConnectMenuOptions): MenuItem[] {
  const { t, showMenu, openMultiConnect } = options
  return [
    {
      label: t('Connect as…'),
      // Below the plain connect and its split, and marked off from them: these
      // two ask a question first, and the two above do not.
      separated: true,
      onSelect: () => showMenu(accountItems(options))
    },
    { label: t('Connect several times…'), onSelect: openMultiConnect }
  ]
}
