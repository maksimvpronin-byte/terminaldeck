import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AppearanceDefaults, AuthMethod, InventorySource } from '../../../shared/types'
import { resolveAppearance } from '../../../shared/appearance'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

export default function InventorySourceDialog({
  initial,
  onClose
}: {
  initial?: InventorySource
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const saveInventorySource = useStore((s) => s.saveInventorySource)
  const sessions = useStore((s) => s.sessions)
  const settings = useStore((s) => s.settings)

  const [source, setSource] = useState<InventorySource>(
    initial ?? { id: nanoid(), name: '', repoUrl: '', paths: [] }
  )
  const [pathsInput, setPathsInput] = useState((initial?.paths ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function set<K extends keyof InventorySource>(key: K, value: InventorySource[K]): void {
    setSource((s) => ({ ...s, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setSource((s) => ({ ...s, [key]: value }))
  }

  // The source is its own tree's root, so it has no group above it to inherit
  // from — only the application-wide settings.
  const appearance = resolveAppearance(source, null, [], settings)

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
        <h2>{initial ? t('Edit inventory source') : t('Add inventory source')}</h2>
        <p className="settings-note">
          {t(
            'The repository is cloned read-only through your system git, so your existing SSH keys or credential helper are used and nothing is ever pushed back.'
          )}
        </p>

        <label>
          {t('Name')}
          <input autoFocus value={source.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <label>
          {t('Repository URL')}
          <input
            value={source.repoUrl}
            placeholder="git@github.com:org/infra.git"
            onChange={(e) => set('repoUrl', e.target.value)}
          />
        </label>

        <div className="form-row">
          <label style={{ flex: 1 }}>
            {t('Branch')}
            <input
              value={source.branch ?? ''}
              placeholder={t('default branch')}
              onChange={(e) => set('branch', e.target.value || undefined)}
            />
          </label>
          <label style={{ flex: 2 }}>
            {t('Inventory paths (comma separated)')}
            <input
              value={pathsInput}
              placeholder="inventories/prod/hosts.yml"
              onChange={(e) => setPathsInput(e.target.value)}
            />
          </label>
        </div>
        <p className="settings-note">
          {t(
            'A path may be a file or a directory of *.yml files — a directory is read one level deep, and an inventory in INI format is not read at all. Leave empty to scan the repository root. Neighbouring group_vars/ and host_vars/ are read automatically.'
          )}
        </p>
        <p className="settings-note">
          {t(
            'Leaving Branch empty follows the repository’s default branch, usually main. Work committed to another branch will not appear here until you name that branch or merge it — the sync succeeds either way, so it looks like nothing changed.'
          )}
        </p>

        <h3 className="settings-heading">{t('Default connection settings')}</h3>
        <p className="settings-note">
          {t(
            'Inherited by every host from this repository unless the inventory or the host itself says otherwise.'
          )}
        </p>

        <div className="form-row">
          <label style={{ flex: 3 }}>
            {t('Username')}
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
          {t('Auth method')}
          <select
            value={source.authMethod ?? ''}
            onChange={(e) => set('authMethod', (e.target.value || undefined) as AuthMethod)}
          >
            <option value="">{t('Not set (password)')}</option>
            <option value="password">{t('Password')}</option>
            <option value="privateKey">{t('Private key')}</option>
            <option value="agent">{t('SSH agent')}</option>
          </select>
        </label>

        {source.authMethod === 'privateKey' && (
          <div className="form-row">
            <label style={{ flex: 1 }}>
              {t('Private key file')}
              <input
                readOnly
                value={source.privateKeyPath ?? ''}
                placeholder={t('No file selected')}
              />
            </label>
            <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
              {t('Browse…')}
            </button>
          </div>
        )}

        <label>
          {t('Jump host (ProxyJump)')}
          <select
            value={source.jumpHostId ?? ''}
            onChange={(e) => set('jumpHostId', e.target.value || undefined)}
          >
            <option value="">{t('None')}</option>
            {/* Saved sessions only: an inventory host is rebuilt on every sync. */}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-note">
          {t(
            'Set this when the repository describes machines behind a bastion — every host from it will be reached through that session.'
          )}
        </p>

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={source.followTerminalCwd ?? false}
            onChange={(e) => set('followTerminalCwd', e.target.checked)}
          />
          {t('SFTP panel follows the terminal’s directory')}
        </label>

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={source.agentForward ?? false}
            onChange={(e) => set('agentForward', e.target.checked)}
          />
          {t('Forward SSH agent to remote hosts')}
        </label>

        <label>
          {t('On connect')}
          <textarea
            rows={2}
            value={source.onConnectCommand ?? ''}
            placeholder={t('e.g. sudo -i')}
            onChange={(e) => set('onConnectCommand', e.target.value)}
          />
        </label>
        <p className="settings-note">
          {t(
            'Run on every host from this repository, one command per line. Set here and nowhere else — it is never read from the inventory itself, because that would let anyone who can commit to the repository run commands on your machines.'
          )}
        </p>

        <label>
          {t('Colour')}
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

        <details className="settings-section">
          <summary>{t('Appearance')}</summary>
          <p className="settings-note">
            {t(
              'Every host from this repository inherits it, so a whole environment can be told apart at a glance without touching a single host.'
            )}
          </p>
          <AppearanceFields
            value={source}
            set={setLook}
            effective={appearance}
            inherited={settings}
            inheritedFrom={() => 'Settings'}
          />
        </details>

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? t('Syncing…') : t('Save and sync')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
