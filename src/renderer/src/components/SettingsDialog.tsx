import { useState } from 'react'
import { useStore } from '../state/store'
import { FONT_CHOICES, THEMES, DEFAULT_SETTINGS, themeOf } from '../state/settings'
import SecuritySettings from './SecuritySettings'
import ModalBackdrop from './ModalBackdrop'

export default function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const preview = themeOf(settings)
  const [tab, setTab] = useState<'terminal' | 'security'>('terminal')

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="settings-tabs">
          <button
            className={tab === 'terminal' ? 'active' : ''}
            onClick={() => setTab('terminal')}
          >
            Terminal
          </button>
          <button
            className={tab === 'security' ? 'active' : ''}
            onClick={() => setTab('security')}
          >
            Security
          </button>
        </div>

        {tab === 'security' && <SecuritySettings />}

        {tab === 'terminal' && (
          <>
        <label>
          Font
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
            Font size
            <input
              type="number"
              min={8}
              max={32}
              value={settings.fontSize}
              onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label>
            Scrollback (lines)
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
          Colour theme
          <select
            value={settings.themeName}
            onChange={(e) => updateSettings({ themeName: e.target.value })}
          >
            {Object.keys(THEMES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
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
            Cursor style
            <select
              value={settings.cursorStyle}
              onChange={(e) =>
                updateSettings({ cursorStyle: e.target.value as typeof settings.cursorStyle })
              }
            >
              <option value="block">Block</option>
              <option value="underline">Underline</option>
              <option value="bar">Bar</option>
            </select>
          </label>
          <label className="checkbox-row" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            <input
              type="checkbox"
              checked={settings.cursorBlink}
              onChange={(e) => updateSettings({ cursorBlink: e.target.checked })}
            />
            Blinking cursor
          </label>
        </div>
          </>
        )}

        <div className="modal-actions">
          {tab === 'terminal' && (
            <button onClick={() => updateSettings(DEFAULT_SETTINGS)}>Reset to defaults</button>
          )}
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
