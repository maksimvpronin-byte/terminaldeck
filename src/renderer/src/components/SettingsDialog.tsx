import { useState } from 'react'
import { useStore } from '../state/store'
import { FONT_CHOICES, THEMES, DEFAULT_SETTINGS, themeOf } from '../state/settings'
import SecuritySettings from './SecuritySettings'
import ModalBackdrop from './ModalBackdrop'
import { keyHint } from '../state/keys'

export default function SettingsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const preview = themeOf(settings)
  const [tab, setTab] = useState<'terminal' | 'files' | 'security'>('terminal')

  async function pickEditor(): Promise<void> {
    const path = await window.td.dialogs.pickOpenPath()
    if (path) updateSettings({ externalEditor: path })
  }

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
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            Files
          </button>
          <button
            className={tab === 'security' ? 'active' : ''}
            onClick={() => setTab('security')}
          >
            Security
          </button>
        </div>

        {tab === 'files' && (
          <>
            <h3 className="settings-heading">External editor</h3>
            <p className="settings-note">
              Used by “Edit locally” in the SFTP panel. Leave empty to hand the file to whatever
              the system opens it with — on Windows that is often Notepad, or nothing at all.
            </p>
            <div className="form-row">
              <label style={{ flex: 1 }}>
                Command
                <input
                  value={settings.externalEditor}
                  placeholder="e.g. code -w {file}"
                  onChange={(e) => updateSettings({ externalEditor: e.target.value })}
                />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickEditor}>
                Browse…
              </button>
            </div>
            <p className="settings-note">
              <code>{'{file}'}</code> is replaced by the path; without it the path is appended.
              Give the full path to the program — a windowed app does not inherit the PATH from
              your shell, so a bare <code>code</code> or <code>subl</code> may not be found.
            </p>
          </>
        )}

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
            <div className="stepper">
              <button
                title={keyHint('Smaller (⌘−)')}
                disabled={settings.fontSize <= 8}
                onClick={() => updateSettings({ fontSize: settings.fontSize - 1 })}
              >
                −
              </button>
              <span className="stepper-value">{settings.fontSize}</span>
              <button
                title={keyHint('Larger (⌘+)')}
                disabled={settings.fontSize >= 32}
                onClick={() => updateSettings({ fontSize: settings.fontSize + 1 })}
              >
                +
              </button>
            </div>
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

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={settings.copyOnSelect}
            onChange={(e) => updateSettings({ copyOnSelect: e.target.checked })}
          />
          Copy to clipboard as soon as text is selected
        </label>

        <label>
          Right-click in a terminal
          <select
            value={settings.rightClick}
            onChange={(e) =>
              updateSettings({ rightClick: e.target.value as typeof settings.rightClick })
            }
          >
            <option value="paste">Paste clipboard</option>
            <option value="menu">Open context menu</option>
          </select>
        </label>
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
