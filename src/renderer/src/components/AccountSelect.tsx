import type { Credential, SessionGroup } from '../../../shared/types'
import { describeCredential } from './connectMenu'
import Hint from './Hint'
import { useT } from '../i18n'

/**
 * Which saved account a host or a folder signs in with by default.
 *
 * Blank inherits: from the folder above, or — where nothing above names an
 * account — the login typed in the fields under this one. A chosen account
 * replaces those fields, so the dialog hides them while one is chosen here.
 */
export default function AccountSelect({
  value,
  onChange,
  credentials,
  inherited
}: {
  value: string | undefined
  onChange: (credentialId: string | undefined) => void
  credentials: Credential[]
  /** The account a blank here falls back to, and the folder it comes from. */
  inherited?: { credential: Credential; from: SessionGroup | 'self' }
}): JSX.Element {
  const t = useT()
  const known = !value || credentials.some((c) => c.id === value)
  return (
    <label>
      <Hint label={t('Default account')}>
        {t(
          'A saved account from Settings → Accounts. Its login and password are used instead of the fields below, and hosts inside a folder inherit it unless they name a login or an account of their own.'
        )}
      </Hint>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">
          {inherited && inherited.from !== 'self'
            ? t('Inherit ({account}, from {group})', {
                account: inherited.credential.name,
                group: inherited.from.name
              })
            : t('None — the login below')}
        </option>
        {credentials.map((c) => (
          <option key={c.id} value={c.id}>
            {describeCredential(c)}
          </option>
        ))}
        {!known && <option value={value}>{t('(deleted account)')}</option>}
      </select>
    </label>
  )
}
