import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AuthMethod, InventorySource } from '../../../shared/types'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import ModalBackdrop from './ModalBackdrop'

export default function InventorySourceDialog({
  initial,
  onClose
}: {
  initial?: InventorySource
  onClose: () => void
}): JSX.Element {
  const saveInventorySource = useStore((s) => s.saveInventorySource)

  const [source, setSource] = useState<InventorySource>(
    initial ?? { id: nanoid(), name: '', repoUrl: '', paths: [] }
  )
  const [pathsInput, setPathsInput] = useState((initial?.paths ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof InventorySource>(key: K, value: InventorySource[K]): void {
    setSource((s) => ({ ...s, [key]: value }))
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  async function submit(): Promise<void> {
    if (!source.name.trim() || !source.repoUrl.trim()) {
      setError('Name and repository URL are required')
      return
    }
    setBusy(true)
    setError(null)
    const paths = pathsInput
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    await saveInventorySource({ ...source, paths })
    setBusy(false)
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{initial ? 'Edit inventory source' : 'Add inventory source'}</h2>
        <p className="settings-note">
          The repository is cloned read-only through your system git, so your existing SSH keys or
          credential helper are used and nothing is ever pushed back.
        </p>

        <label>
          Name
          <input autoFocus value={source.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <label>
          Repository URL
          <input
            value={source.repoUrl}
            placeholder="git@github.com:org/infra.git"
            onChange={(e) => set('repoUrl', e.target.value)}
          />
        </label>

        <div className="form-row">
          <label style={{ flex: 1 }}>
            Branch
            <input
              value={source.branch ?? ''}
              placeholder="default branch"
              onChange={(e) => set('branch', e.target.value || undefined)}
            />
          </label>
          <label style={{ flex: 2 }}>
            Inventory paths (comma separated)
            <input
              value={pathsInput}
              placeholder="inventories/prod/hosts.yml"
              onChange={(e) => setPathsInput(e.target.value)}
            />
          </label>
        </div>
        <p className="settings-note">
          A path may be a file or a directory of *.yml files. Leave empty to scan the repository
          root. Neighbouring group_vars/ and host_vars/ are read automatically.
        </p>

        <h3 className="settings-heading">Default connection settings</h3>
        <p className="settings-note">
          Inherited by every host from this repository unless the inventory or the host itself says
          otherwise.
        </p>

        <div className="form-row">
          <label style={{ flex: 3 }}>
            Username
            <input
              value={source.username ?? ''}
              onChange={(e) => set('username', e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              type="number"
              value={source.port ?? ''}
              placeholder="22"
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        <label>
          Auth method
          <select
            value={source.authMethod ?? ''}
            onChange={(e) => set('authMethod', (e.target.value || undefined) as AuthMethod)}
          >
            <option value="">Not set (password)</option>
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>

        {source.authMethod === 'privateKey' && (
          <div className="form-row">
            <label style={{ flex: 1 }}>
              Private key file
              <input readOnly value={source.privateKeyPath ?? ''} placeholder="No file selected" />
            </label>
            <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
              Browse…
            </button>
          </div>
        )}

        <label>
          Colour
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!source.color ? 'selected' : ''}`}
              onClick={() => set('color', undefined)}
            />
            {SESSION_COLOURS.map((c) => (
              <button
                type="button"
                key={c.value}
                className={`swatch ${source.color === c.value ? 'selected' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                onClick={() => set('color', c.value)}
              />
            ))}
          </div>
        </label>

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? 'Syncing…' : 'Save and sync'}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
