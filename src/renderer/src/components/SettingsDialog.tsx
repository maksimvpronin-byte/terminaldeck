import { useId, useState, type CSSProperties } from 'react'
import { useStore } from '../state/store'
import {
  FONT_CHOICES,
  THEME_GROUPS,
  TREE_ROW_DEFAULT,
  TREE_ROW_MAX,
  TREE_ROW_MIN,
  terminalDefaults,
  themeOf,
  treeDefaults,
  treeRowHeightOf,
  treeTintOf,
  type TreeTint
} from '../state/settings'
import SecuritySettings from './SecuritySettings'
import CredentialsSettings from './CredentialsSettings'
import BackupSettings from './BackupSettings'
import AboutSettings from './AboutSettings'
import { SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import { TerminalIcon } from './icons'
import PageIcon from './PageIcon'
import ModalBackdrop from './ModalBackdrop'
import { keyHint } from '../state/keys'
import { LANGUAGES, useT, type Language } from '../i18n'

export type SettingsTab =
  'general' | 'tree' | 'terminal' | 'files' | 'accounts' | 'security' | 'backup' | 'about'

/**
 * Three made-up hosts drawn with the tree's own classes, so every setting on
 * the page shows on them as it will in the tree — fill, edge, bold, height.
 */
function TreePreview(): JSX.Element {
  const rows = [
    { name: 'web-01.prod', colour: '#3fb950', open: true },
    { name: 'db-01.prod', colour: '#e5534b', open: false },
    { name: 'build.lab', colour: undefined, open: false }
  ]
  return (
    <div className="sidebar-tree tree-preview" aria-hidden="true">
      {rows.map((row) => (
        <div
          key={row.name}
          className={`tree-item${row.colour ? ' tinted' : ''}`}
          style={(row.colour ? { '--host-colour': row.colour } : {}) as CSSProperties}
        >
          <span className="name">
            <span className={`session-kind${row.open ? ' live' : ''}`}>
              <TerminalIcon />
            </span>
            {row.name}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function SettingsDialog({
  initialTab,
  onClose
}: {
  /** Which page to open on, for the menus that come here to do one thing. */
  initialTab?: SettingsTab
  onClose: () => void
}): JSX.Element {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const preview = themeOf(settings)
  const t = useT()
  const id = useId()
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'general')
  /*
   * Typed, then taken on leaving the field. Taken keystroke by keystroke, the
   * "5" of 5000 is out of range and settings put the default back under the
   * caret — and the "500" on the way would cut every terminal's history short.
   */
  const [scrollbackDraft, setScrollbackDraft] = useState<string | null>(null)
  function commitScrollback(): void {
    if (scrollbackDraft === null) return
    const lines = Number(scrollbackDraft)
    if (Number.isInteger(lines) && lines >= 100 && lines <= 200000) {
      updateSettings({ scrollback: lines })
    }
    setScrollbackDraft(null)
  }

  async function pickEditor(): Promise<void> {
    const path = await window.td.dialogs.pickOpenPath()
    if (path) updateSettings({ externalEditor: path })
  }

  /*
   * A list down the side rather than a row of tabs across the top. Six tabs
   * already wrapped onto a second line in a 460px card, and the Russian labels
   * are the longer ones; a column takes any number of pages in any language,
   * and the groups say which pages are about this machine's look and feel and
   * which about what it keeps.
   */
  const sections: Array<{ title: string; pages: Array<{ id: SettingsTab; label: string }> }> = [
    {
      title: t('Application'),
      pages: [
        { id: 'general', label: t('General') },
        { id: 'tree', label: t('Tree and tabs') },
        { id: 'terminal', label: t('Terminal') },
        { id: 'files', label: t('Files') }
      ]
    },
    {
      title: t('Access and data'),
      pages: [
        { id: 'accounts', label: t('Accounts') },
        { id: 'security', label: t('Security') },
        { id: 'backup', label: t('Backup') }
      ]
    },
    { title: '', pages: [{ id: 'about', label: t('About') }] }
  ]
  const current = sections.flatMap((s) => s.pages).find((p) => p.id === tab)

  /* Only the pages whose settings have defaults worth going back to, and only
     their own fields — see `terminalDefaults`. */
  const reset = tab === 'terminal' ? terminalDefaults : tab === 'tree' ? treeDefaults : undefined

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card settings-card" onClick={(e) => e.stopPropagation()}>
        <nav className="settings-nav" aria-label={t('Settings')}>
          <h2>{t('Settings')}</h2>
          {sections.map((section, i) => (
            <div className="settings-nav-section" key={i}>
              {section.title && <div className="settings-nav-title">{section.title}</div>}
              {section.pages.map((page) => (
                <button
                  key={page.id}
                  className={tab === page.id ? 'active' : ''}
                  aria-current={tab === page.id ? 'page' : undefined}
                  onClick={() => setTab(page.id)}
                >
                  <PageIcon page={page.id} />
                  {page.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="settings-page">
          <div className="settings-page-body" key={tab}>
            <h2>{current?.label}</h2>

            {tab === 'general' && (
              <>
                <SettingsGroup title={t('Interface')}>
                  <SettingRow
                    controlId={`${id}-language`}
                    label={t('Language')}
                    hint={t('Applies at once, and to this window only — nothing is sent anywhere.')}
                  >
                    <select
                      id={`${id}-language`}
                      value={settings.language}
                      onChange={(e) => updateSettings({ language: e.target.value as Language })}
                    >
                      {LANGUAGES.map((language) => (
                        <option key={language.id} value={language.id}>
                          {language.name}
                        </option>
                      ))}
                    </select>
                  </SettingRow>
                </SettingsGroup>

                <SettingsGroup title={t('Session logs')}>
                  <SettingRow
                    label={t('Logs folder')}
                    note={t(
                      'Sessions with “Log session output to file” enabled write here. The transcript contains everything the terminal showed, so treat it as sensitive.'
                    )}
                  >
                    <button onClick={() => window.td.logs.reveal()}>{t('Open logs folder')}</button>
                  </SettingRow>
                </SettingsGroup>
              </>
            )}

            {tab === 'tree' && (
              <>
                <SettingsGroup title={t('Behaviour')}>
                  <SwitchRow
                    label={t('Open groups only by their arrow')}
                    note={t('Off, a click anywhere on the row opens and closes a group.')}
                    checked={settings.expandOnArrowOnly}
                    onChange={(on) => updateSettings({ expandOnArrowOnly: on })}
                  />
                  <SwitchRow
                    label={t('Show the host of the tab in front')}
                    note={t('Selects it in the tree and scrolls to it.')}
                    checked={settings.revealActiveHost}
                    onChange={(on) => updateSettings({ revealActiveHost: on })}
                  />
                  <SwitchRow
                    label={t('Double-click on an open host goes to its tab')}
                    hint={t(
                      '“Open another tab” in the host’s menu still opens a second one. A desktop is never opened twice for one account, whatever this says: Windows keeps one session per user, and a second tab would take it from the first.'
                    )}
                    checked={settings.reuseOpenHost}
                    onChange={(on) => updateSettings({ reuseOpenHost: on })}
                  />
                  <SwitchRow
                    label={t('Double-click on a connected host reconnects it')}
                    note={t('For terminals and desktops alike.')}
                    hint={t(
                      'A host that has dropped is reconnected by a double-click either way. A terminal reaches its open tab only while the setting above is on; off, a double-click opens another tab and nothing is reconnected. A terminal starts a new shell, and whatever ran in the old one ends with it. A desktop signs in again to the same Windows session, so what was open on it stays open.'
                    )}
                    checked={settings.reconnectOnDoubleClick}
                    onChange={(on) => updateSettings({ reconnectOnDoubleClick: on })}
                  />
                  <SwitchRow
                    label={t('Double-click on a tab reconnects it')}
                    note={t('The pane in front in the tab, connected or dropped.')}
                    checked={settings.reconnectOnTabDoubleClick}
                    onChange={(on) => updateSettings({ reconnectOnTabDoubleClick: on })}
                  />
                  <SwitchRow
                    label={t('A workspace for each group')}
                    note={t('A host opens in a workspace named after its group.')}
                    hint={t(
                      'Off, a host opened from the tree goes to an ordinary workspace — the one in front, unless that one is a set’s. A host opened from a set goes to the set’s workspace either way.'
                    )}
                    checked={settings.workspacePerGroup}
                    onChange={(on) => updateSettings({ workspacePerGroup: on })}
                  />
                </SettingsGroup>

                <SettingsGroup title={t('Appearance')}>
                  <TreePreview />
                  <SettingRow controlId={`${id}-tint`} label={t('Colour of coloured rows')}>
                    <select
                      id={`${id}-tint`}
                      value={treeTintOf(settings)}
                      onChange={(e) => updateSettings({ treeTint: e.target.value as TreeTint })}
                    >
                      <option value="fade">{t('Fading from the edge')}</option>
                      <option value="flat">{t('Even and faint, across the row')}</option>
                    </select>
                  </SettingRow>
                  <SwitchRow
                    label={t('A stripe of the colour down the left edge')}
                    checked={settings.treeEdge}
                    onChange={(on) => updateSettings({ treeEdge: on })}
                  />
                  <SwitchRow
                    label={t('Name open hosts in bold')}
                    checked={settings.treeBoldOpen}
                    onChange={(on) => updateSettings({ treeBoldOpen: on })}
                  />
                  <SettingRow
                    controlId={`${id}-row`}
                    label={t('Row height')}
                    hint={t(
                      'How close together hosts and groups sit in the left panel. {px} px is the usual height; lower packs a long list onto one screen.',
                      { px: TREE_ROW_DEFAULT }
                    )}
                  >
                    <input
                      id={`${id}-row`}
                      type="range"
                      min={TREE_ROW_MIN}
                      max={TREE_ROW_MAX}
                      step={1}
                      value={treeRowHeightOf(settings)}
                      onChange={(e) => updateSettings({ treeRowHeight: Number(e.target.value) })}
                    />
                    <span className="setting-value range-value">
                      {treeRowHeightOf(settings)} px
                    </span>
                  </SettingRow>
                </SettingsGroup>
              </>
            )}

            {tab === 'terminal' && (
              <>
                {/* A statement about the whole page rather than about one
                    control, so it stays where it can be read without being
                    looked for. */}
                <p className="settings-note">
                  {t(
                    'The defaults every terminal starts from. A group or a single host can override any of this in its own dialog, under Appearance.'
                  )}
                </p>

                <SettingsGroup title={t('Font and colours')}>
                  <SettingRow controlId={`${id}-font`} label={t('Font')}>
                    <select
                      id={`${id}-font`}
                      value={settings.fontFamily}
                      onChange={(e) => updateSettings({ fontFamily: e.target.value })}
                    >
                      {FONT_CHOICES.map((f) => (
                        <option key={f} value={f}>
                          {f.split(',')[0]}
                        </option>
                      ))}
                    </select>
                  </SettingRow>
                  <SettingRow label={t('Font size')}>
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
                  </SettingRow>
                  <SettingRow controlId={`${id}-theme`} label={t('Colour theme')}>
                    <select
                      id={`${id}-theme`}
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
                  </SettingRow>
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
                    <div style={{ color: preview.red ?? preview.foreground }}>
                      permission denied
                    </div>
                  </div>
                </SettingsGroup>

                <SettingsGroup title={t('Cursor')}>
                  <SettingRow controlId={`${id}-cursor`} label={t('Cursor style')}>
                    <select
                      id={`${id}-cursor`}
                      value={settings.cursorStyle}
                      onChange={(e) =>
                        updateSettings({
                          cursorStyle: e.target.value as typeof settings.cursorStyle
                        })
                      }
                    >
                      <option value="block">{t('Block')}</option>
                      <option value="underline">{t('Underline')}</option>
                      <option value="bar">{t('Bar')}</option>
                    </select>
                  </SettingRow>
                  <SwitchRow
                    label={t('Blinking cursor')}
                    checked={settings.cursorBlink}
                    onChange={(on) => updateSettings({ cursorBlink: on })}
                  />
                </SettingsGroup>

                <SettingsGroup title={t('Scrollback and clipboard')}>
                  <SettingRow controlId={`${id}-scrollback`} label={t('Scrollback (lines)')}>
                    <input
                      id={`${id}-scrollback`}
                      type="number"
                      min={100}
                      max={200000}
                      step={1000}
                      value={scrollbackDraft ?? settings.scrollback}
                      onChange={(e) => setScrollbackDraft(e.target.value)}
                      onBlur={commitScrollback}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitScrollback()
                      }}
                    />
                  </SettingRow>
                  <SwitchRow
                    label={t('Copy to clipboard as soon as text is selected')}
                    checked={settings.copyOnSelect}
                    onChange={(on) => updateSettings({ copyOnSelect: on })}
                  />
                  <SettingRow controlId={`${id}-right`} label={t('Right-click in a terminal')}>
                    <select
                      id={`${id}-right`}
                      value={settings.rightClick}
                      onChange={(e) =>
                        updateSettings({ rightClick: e.target.value as typeof settings.rightClick })
                      }
                    >
                      <option value="paste">{t('Paste clipboard')}</option>
                      <option value="menu">{t('Open context menu')}</option>
                    </select>
                  </SettingRow>
                </SettingsGroup>

                <SettingsGroup title={t('SSH sessions')}>
                  <SwitchRow
                    label={t('Show the monitor under every SSH session')}
                    hint={t(
                      'The strip the Monitor button opens — load, memory, disks — under every terminal, without pressing it in each. The button then closes it for that pane alone.'
                    )}
                    checked={settings.monitorForAll}
                    onChange={(on) => updateSettings({ monitorForAll: on })}
                  />
                </SettingsGroup>
              </>
            )}

            {tab === 'files' && (
              <SettingsGroup title={t('External editor')}>
                <SettingRow
                  stacked
                  controlId={`${id}-editor`}
                  label={t('Command')}
                  hint={
                    <>
                      {t(
                        'Used by “Edit locally” in the SFTP panel. Left empty, the file opens in Notepad on Windows and in your default text editor on macOS — never in whatever program would run it.'
                      )}{' '}
                      <code>{'{file}'}</code>{' '}
                      {t(
                        'is replaced by the path; without it the path is appended. Give the full path to the program — a windowed app does not inherit the PATH from your shell, so a bare code or subl may not be found.'
                      )}
                    </>
                  }
                >
                  <input
                    id={`${id}-editor`}
                    value={settings.externalEditor}
                    placeholder="code -w {file}"
                    onChange={(e) => updateSettings({ externalEditor: e.target.value })}
                  />
                  <button onClick={pickEditor}>{t('Browse…')}</button>
                </SettingRow>
              </SettingsGroup>
            )}

            {tab === 'accounts' && <CredentialsSettings />}
            {tab === 'security' && <SecuritySettings />}
            {tab === 'backup' && <BackupSettings />}
            {tab === 'about' && <AboutSettings />}
          </div>

          <div className="modal-actions settings-actions">
            {reset && <button onClick={() => updateSettings(reset())}>{t('Reset section')}</button>}
            <button className="primary" onClick={onClose}>
              {t('Done')}
            </button>
          </div>
        </div>
      </div>
    </ModalBackdrop>
  )
}
