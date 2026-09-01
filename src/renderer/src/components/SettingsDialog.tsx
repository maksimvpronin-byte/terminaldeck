import { useState } from 'react'
import { useStore } from '../state/store'
import { FONT_CHOICES, THEME_GROUPS, DEFAULT_SETTINGS, themeOf } from '../state/settings'
import SecuritySettings from './SecuritySettings'
import BackupSettings from './BackupSettings'
import Hint from './Hint'
import ModalBackdrop from './ModalBackdrop'
import { keyHint } from '../state/keys'
import { LANGUAGES, useT, type Language } from '../i18n'

export default function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const preview = themeOf(settings)
  const t = useT()
  const [tab, setTab] = useState<'general' | 'terminal' | 'files' | 'security' | 'backup'>(
    'general'
  )

  async function pickEditor(): Promise<void> {
    const path = await window.td.dialogs.pickOpenPath()
    if (path) updateSettings({ externalEditor: path })
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Settings')}</h2>

        {/* Nothing floats above the tabs any more. Language sat up here, which
            put it on every tab — a setting somebody changes once, permanently in
            front of the ones they came to change. */}
        <div className="settings-tabs">
          <button
            className={tab === 'general' ? 'active' : ''}
            onClick={() => setTab('general')}
          >
            {t('General')}
          </button>
          <button
            className={tab === 'terminal' ? 'active' : ''}
            onClick={() => setTab('terminal')}
          >
            {t('Terminal')}
          </button>
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            {t('Files')}
          </button>
          <button
            className={tab === 'security' ? 'active' : ''}
            onClick={() => setTab('security')}
          >
            {t('Security')}
          </button>
          <button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>
            {t('Backup')}
          </button>
        </div>

        {tab === 'files' && (
          <>
            <h3 className="settings-heading">{t('External editor')}</h3>
            <div className="form-row">
              <label style={{ flex: 1 }}>
                <Hint label={t('Command')}>
                  {t(
                    'Used by “Edit locally” in the SFTP panel. Leave empty to hand the file to whatever the system opens it with — on Windows that is often Notepad, or nothing at all.'
                  )}{' '}
                  <code>{'{file}'}</code>{' '}
                  {t(
                    'is replaced by the path; without it the path is appended. Give the full path to the program — a windowed app does not inherit the PATH from your shell, so a bare code or subl may not be found.'
                  )}
                </Hint>
                <input
                  value={settings.externalEditor}
                  placeholder="e.g. code -w {file}"
                  onChange={(e) => updateSettings({ externalEditor: e.target.value })}
                />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickEditor}>
                {t('Browse…')}
              </button>
            </div>
          </>
        )}

        {tab === 'security' && <SecuritySettings />}
        {tab === 'backup' && <BackupSettings />}

        {tab === 'general' && (
          <label>
            <Hint label={t('Language')}>
              {t('Applies at once, and to this window only — nothing is sent anywhere.')}
            </Hint>
            <select
              value={settings.language}
              onChange={(e) => updateSettings({ language: e.target.value as Language })}
            >
              {LANGUAGES.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {tab === 'terminal' && (
          <>
            {/* A statement about the whole tab rather than about one control,
                so it stays where it can be read without being looked for. */}
            <p className="settings-note">
              {t(
                'The defaults every terminal starts from. A group or a single host can override any of this in its own dialog, under Appearance.'
              )}
            </p>

        <label>
          {t('Font')}
          <select
            value={settings.fontFamily}
            onChange={(e) => updateSettings({ fontFamily: e.target.value })}
          >
            {FONT_CHOICES.map((f) => (
              <option key={f} value={f}>
                {f.split(',')[0]}
              </option>
            ))}
          </select>
        </label>

        <div className="form-row">
          <label>
            {t('Font size')}
            <div className="stepper">
              <button
                title={keyHint(t('Smaller (⌘−)'))}
                disabled={settings.fontSize <= 8}
                onClick={() => updateSettings({ fontSize: settings.fontSize - 1 })}
              >
                −
              </button>
              <span className="stepper-value">{settings.fontSize}</span>
              <button
                title={keyHint(t('Larger (⌘+)'))}
                disabled={settings.fontSize >= 32}
                onClick={() => updateSettings({ fontSize: settings.fontSize + 1 })}
              >
                +
              </button>
            </div>
          </label>
          <label>
            {t('Scrollback (lines)')}
            <input
              type="number"
              min={100}
              max={200000}
              step={1000}
              value={settings.scrollback}
              onChange={(e) => updateSettings({ scrollback: Number(e.target.value) })}
            />
          </label>
        </div>

        <label>
          {t('Colour theme')}
          <select
            value={settings.themeName}
            onChange={(e) => updateSettings({ themeName: e.target.value })}
          >
            {THEME_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <div
          className="theme-preview"
          style={{
            background: preview.background,
            color: preview.foreground,
            fontFamily: settings.fontFamily,
            fontSize: settings.fontSize
          }}
        >
          <div>
            <span style={{ color: preview.green ?? preview.foreground }}>user@host</span>:
            <span style={{ color: preview.blue ?? preview.foreground }}>~</span>${' '}
            <span>ls -la</span>
          </div>
          <div style={{ color: preview.red ?? preview.foreground }}>permission denied</div>
        </div>

        <div className="form-row">
          <label>
            {t('Cursor style')}
            <select
              value={settings.cursorStyle}
              onChange={(e) =>
                updateSettings({ cursorStyle: e.target.value as typeof settings.cursorStyle })
              }
            >
              <option value="block">{t('Block')}</option>
              <option value="underline">{t('Underline')}</option>
              <option value="bar">{t('Bar')}</option>
            </select>
          </label>
          <label className="checkbox-row" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            <input
              type="checkbox"
              checked={settings.cursorBlink}
              onChange={(e) => updateSettings({ cursorBlink: e.target.checked })}
            />
            {t('Blinking cursor')}
          </label>
        </div>

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={settings.copyOnSelect}
            onChange={(e) => updateSettings({ copyOnSelect: e.target.checked })}
          />
          {t('Copy to clipboard as soon as text is selected')}
        </label>

        <label>
          {t('Right-click in a terminal')}
          <select
            value={settings.rightClick}
            onChange={(e) =>
              updateSettings({ rightClick: e.target.value as typeof settings.rightClick })
            }
          >
            <option value="paste">{t('Paste clipboard')}</option>
            <option value="menu">{t('Open context menu')}</option>
          </select>
        </label>
          </>
        )}

        <div className="modal-actions">
          {tab === 'terminal' && (
            <button onClick={() => updateSettings(DEFAULT_SETTINGS)}>{t('Reset to defaults')}</button>
          )}
          <button className="primary" onClick={onClose}>
            {t('Done')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
