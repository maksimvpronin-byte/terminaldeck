import { useState } from 'react'
import type { AuthMethod, QuickConnectParams } from '../../../shared/types'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

export default function QuickConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const openTab = useStore((s) => s.openTab)
  const [host, setHost] = useState('')
  const [port, setPort] = useState(22)
  const [username, setUsername] = useState('')
  const [authMethod, setAuthMethod] = useState<AuthMethod>('password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) setPrivateKeyPath(path)
  }

  function connect(): void {
    if (!host.trim() || !username.trim()) {
      setError(t('Host and username are required'))
      return
    }
    const params: QuickConnectParams = {
      host,
      port,
      username,
      authMethod,
      password: authMethod === 'password' ? password : undefined,
      privateKeyPath: authMethod === 'privateKey' ? privateKeyPath : undefined,
      passphrase: authMethod === 'privateKey' ? passphrase : undefined
    }
    openTab(`${username}@${host}`, { kind: 'quick', params })
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Quick connect')}</h2>
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
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          {t('Auth method')}
          <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}>
            <option value="password">{t('Password')}</option>
            <option value="privateKey">{t('Private key')}</option>
            <option value="agent">{t('SSH agent')}</option>
          </select>
        </label>
        {authMethod === 'password' && (
          <label>
            {t('Password')}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && connect()}
            />
          </label>
        )}
        {authMethod === 'privateKey' && (
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
