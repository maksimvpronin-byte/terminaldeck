import { useState } from 'react'
import type { AuthMethod, QuickConnectParams } from '../../../shared/types'
import { PROTOCOLS, traitsOf, type Protocol } from '../../../shared/protocols'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

export default function QuickConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const openTab = useStore((s) => s.openTab)
  const [protocol, setProtocol] = useState<Protocol>('ssh')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(traitsOf('ssh').port)
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)

  const isRdp = protocol === 'rdp'

  /**
   * A port still at the old protocol's default follows the new one: 22 is not
   * where a desktop is, and a port somebody typed is left as they typed it.
   */
  function chooseProtocol(next: Protocol): void {
    if (next === protocol) return
    if (port === traitsOf(protocol).port) setPort(traitsOf(next).port)
    setProtocol(next)
    setError(null)
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) setPrivateKeyPath(path)
  }

  function connect(): void {
    if (!host.trim() || !username.trim()) {
      setError(t('Host and username are required'))
      return
    }
    // A desktop signs in with a password or not at all; left blank, the pane
    // asks for it, as it does for a saved host with none.
    const method: AuthMethod = isRdp ? 'password' : authMethod
    const params: QuickConnectParams = {
      protocol,
      host: host.trim(),
      port,
      username: username.trim(),
      authMethod: method,
      password: method === 'password' && password ? password : undefined,
      privateKeyPath: method === 'privateKey' ? privateKeyPath : undefined,
      passphrase: method === 'privateKey' ? passphrase : undefined
    }
    openTab(`${params.username}@${params.host}`, { kind: 'quick', params })
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Quick connect')}</h2>
        <div className="protocol-switch" role="radiogroup" aria-label={t('Protocol')}>
          {PROTOCOLS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={protocol === p}
              className={protocol === p ? 'active' : ''}
              onClick={() => chooseProtocol(p)}
            >
              {traitsOf(p).label}
            </button>
          ))}
        </div>
        <div className="form-row">
          <label style={{ flex: 3 }}>
            {t('Host')}
            <input value={host} autoFocus onChange={(e) => setHost(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            {t('Port')}
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </div>
        <label>
          {t('Username')}
          <input
            value={username}
            // The same in every language: it shows the form, not words.
            placeholder={isRdp ? 'DOMAIN\\user, user@domain' : undefined}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        {!isRdp && (
          <label>
            {t('Auth method')}
            <select
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}
            >
              <option value="password">{t('Password')}</option>
              <option value="privateKey">{t('Private key')}</option>
              <option value="agent">{t('SSH agent')}</option>
            </select>
          </label>
        )}
        {(isRdp || authMethod === 'password') && (
          <label>
            {t('Password')}
            <input
              type="password"
              value={password}
              placeholder={isRdp ? t('Leave empty to type it when the desktop opens') : undefined}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connect()}
            />
          </label>
        )}
        {!isRdp && authMethod === 'privateKey' && (
          <>
            <div className="form-row">
              <label style={{ flex: 1 }}>
                {t('Private key file')}
                <input readOnly value={privateKeyPath} placeholder={t('No file selected')} />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
                {t('Browse…')}
              </button>
            </div>
            <label>
              {t('Passphrase')}
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={connect}>
            {t('Connect')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
