import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AuthMethod, Credential } from '../../../shared/types'
import { useStore } from '../state/store'
import { useT, type Translate } from '../i18n'
import Hint from './Hint'

/**
 * Literal phrases in a function rather than a table looked up by key: the
 * phrase book's coverage test reads the source for `t('…')`, and a key built at
 * runtime is invisible to it. The same reason `AuthFields` does this.
 */
function methodLabel(t: Translate, method: AuthMethod): string {
  if (method === 'password') return t('Password')
  if (method === 'privateKey') return t('Private key')
  return t('SSH agent')
}

function blank(): Credential {
  const now = Date.now()
  return {
    id: nanoid(),
    name: '',
    username: '',
    authMethod: 'password',
    createdAt: now,
    updatedAt: now
  }
}

/**
 * The store of logins, and the one screen that fills it.
 *
 * Deliberately not part of the inheritance chain the host dialogs edit. A
 * group's credential is a statement about the machines under it; one of these
 * is a statement about nothing at all until somebody picks it from a host's
 * menu, and the difference is what makes it safe to keep an administrator
 * account here without any host being reached as that account by default.
 *
 * Editing happens in place rather than in a dialog of its own: there are three
 * fields and a secret, the list is short, and a modal over a modal is a way to
 * lose whichever one was underneath.
 */
export default function CredentialsSettings(): JSX.Element {
  const t = useT()
  const credentials = useStore((s) => s.credentials)
  const upsertCredential = useStore((s) => s.upsertCredential)
  const removeCredential = useStore((s) => s.removeCredential)

  /** The account being edited, as the form currently has it. */
  const [draft, setDraft] = useState<Credential | null>(null)
  /** Typed now and not yet saved. Empty means "leave what is stored alone". */
  const [secret, setSecret] = useState('')
  /** Whether saving should drop the secret this account holds. */
  const [forget, setForget] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Whether this is a new account rather than one already in the list. */
  const isNew = draft !== null && !credentials.some((c) => c.id === draft.id)

  function edit(credential: Credential): void {
    setDraft({ ...credential })
    setSecret('')
    setForget(false)
    setError(null)
  }

  function set<K extends keyof Credential>(key: K, value: Credential[K]): void {
    setDraft((current) => {
      if (!current) return current
      return { ...current, [key]: value }
    })
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  async function save(): Promise<void> {
    if (!draft) return
    const name = draft.name.trim()
    const username = draft.username.trim()
    // Both are required, and for the same reason: this is chosen from a menu by
    // name and used to sign in by username, so an account missing either is one
    // nobody can pick or one that cannot connect.
    if (!name || !username) {
      setError(t('An account needs a name and a username'))
      return
    }
    // Something typed beats the forget tick — it is the later answer. The agent
    // carries neither, and the main process drops any secret for it anyway.
    const toSave = secret || (forget ? null : undefined)
    await upsertCredential({ ...draft, name, username }, toSave)
    setDraft(null)
    setSecret('')
    setForget(false)
    setError(null)
  }

  async function remove(credential: Credential): Promise<void> {
    if (
      !window.confirm(
        `${t('Delete the account “{name}”?', { name: credential.name })}\n\n${t(
          'Its password is deleted with it. Sessions already open are not affected.'
        )}`
      )
    ) {
      return
    }
    await removeCredential(credential.id)
    if (draft?.id === credential.id) setDraft(null)
  }

  return (
    <>
      {/* Both halves under the mark rather than one of them down the page: what
          this is, and where it is kept. The second used to sit at the bottom as
          a paragraph of its own, which is four lines of prose in front of a
          screen whose actual business is a list and one button. */}
      <h3 className="settings-heading">
        <Hint label={t('Saved accounts')}>
          {t(
            'Logins kept on their own, so a host can be reached as somebody else without being edited. Right-click a host and choose “Connect as…” to use one; nothing here changes what a host connects as by default.'
          )}{' '}
          {t(
            'Accounts are stored the way hosts are: the file holds a name and a reference, and the password itself lives in the vault. They travel with a backup export, and their passwords only when credentials are included in it.'
          )}
        </Hint>
      </h3>

      {credentials.length === 0 && (
        <p className="settings-note">{t('No accounts saved yet.')}</p>
      )}

      <div className="known-hosts-list">
        {credentials.map((credential) => (
          <div className="credential-row" key={credential.id}>
            <div className="credential-name">{credential.name}</div>
            <div className="credential-who">
              {credential.username} · {methodLabel(t, credential.authMethod)}
              {credential.authMethod !== 'agent' && !credential.secretRef && (
                <> · {t('asks for the password')}</>
              )}
            </div>
            <div className="credential-actions">
              <button onClick={() => edit(credential)}>{t('Edit')}</button>
              <button className="danger" onClick={() => remove(credential)}>
                {t('Delete')}
              </button>
            </div>
          </div>
        ))}
      </div>

      {!draft && (
        <div>
          <button className="primary" onClick={() => edit(blank())}>
            {t('Add an account')}
          </button>
        </div>
      )}

      {draft && (
        <>
          <h3 className="settings-heading">{isNew ? t('New account') : t('Edit account')}</h3>

          <div className="form-row">
            <label style={{ flex: 1 }}>
              <Hint label={t('Name')}>
                {t('What it is called in the menus — “domain admin”, “root”, “svc-backup”.')}
              </Hint>
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label style={{ flex: 1 }}>
              <Hint label={t('Username')}>
                {t(
                  'Sent as typed. Either Windows spelling works — a NetBIOS domain and account, or a user principal name — and each is carried across the way the far end expects.'
                )}
              </Hint>
              <input value={draft.username} onChange={(e) => set('username', e.target.value)} />
            </label>
          </div>

          <label>
            {t('Auth method')}
            <select
              value={draft.authMethod}
              onChange={(e) => set('authMethod', e.target.value as AuthMethod)}
            >
              <option value="password">{t('Password')}</option>
              <option value="privateKey">{t('Private key')}</option>
              <option value="agent">{t('SSH agent')}</option>
            </select>
          </label>

          {draft.authMethod === 'privateKey' && (
            <div className="form-row">
              <label style={{ flex: 1 }}>
                {t('Private key file')}
                <input readOnly value={draft.privateKeyPath ?? ''} placeholder={t('None')} />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
                {t('Browse…')}
              </button>
            </div>
          )}

          {draft.authMethod !== 'agent' && (
            <label>
              {draft.authMethod === 'password' ? t('Password') : t('Passphrase')}
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          )}

          {/* Saving nothing here is a deliberate way to keep an account: the
              name and the login are remembered, and the connection asks for the
              password each time it is used. */}
          {draft.authMethod !== 'agent' && (
            <p className="settings-note action-note">
              {draft.secretRef
                ? forget
                  ? t('Will be forgotten on save')
                  : t('A password is saved for this account')
                : t('Nothing is saved — you will be asked when you connect')}
              {draft.secretRef && (
                <button type="button" onClick={() => setForget(!forget)}>
                  {forget ? t('Keep it') : t('Forget it')}
                </button>
              )}
            </p>
          )}

          {error && <span className="error-text">{error}</span>}

          <div className="form-row">
            <button className="primary" onClick={save}>
              {isNew ? t('Add') : t('Save')}
            </button>
            <button onClick={() => setDraft(null)}>{t('Cancel')}</button>
          </div>
        </>
      )}
    </>
  )
}
