import { useState } from 'react'
import type { AuthMethod, QuickConnectParams } from '../../../shared/types'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'

export default function QuickConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
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
      setError('Host and username are required')
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
        <h2>Quick connect</h2>
        <div className="form-row">
          <label style={{ flex: 3 }}>
            Host
            <input value={host} autoFocus onChange={(e) => setHost(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </div>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Auth method
          <select value={authMethod} onChange={(e) => setAuthMethod(e.target.value as AuthMethod)}>
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>
        {authMethod === 'password' && (
          <label>
            Password
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
                Private key file
                <input readOnly value={privateKeyPath} placeholder="No file selected" />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
                Browse…
              </button>
            </div>
            <label>
              Passphrase
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </label>
          </>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={connect}>
            Connect
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
