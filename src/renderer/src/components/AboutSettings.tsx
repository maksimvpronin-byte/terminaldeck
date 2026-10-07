import { useState } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import { recentNotes } from '../whatsNew'
import { SettingRow, SettingsGroup } from './SettingsGroup'
import { WhatsNewDialog } from './WhatsNew'

/**
 * Which version this is, and whether there is a newer one.
 *
 * The update check lived at the bottom of the backup page, under an export and
 * an import it has nothing to do with, where nobody looking for it would look.
 */
export default function AboutSettings(): JSX.Element {
  const t = useT()
  const language = useStore((s) => s.settings.language)
  const [checking, setChecking] = useState(false)
  /** What the last manual check found, said out loud — see below. */
  const [checked, setChecked] = useState('')
  const [notes, setNotes] = useState(false)

  /**
   * A check by hand, which has to answer even when the answer is "nothing".
   *
   * The banner at the top of the window speaks when there is something to do
   * about an update and stays silent otherwise, which is right for a check
   * nobody asked for and wrong for one somebody just pressed a button for: a
   * button that does nothing visible reads as a broken button.
   */
  async function checkForUpdate(): Promise<void> {
    setChecking(true)
    setChecked('')
    try {
      const found = await window.td.updates.check()
      setChecked(
        !found || found === window.td.appVersion
          ? t('This is the newest version.')
          : t('Version {version} is available.', { version: found })
      )
    } catch (err) {
      setChecked(String((err as Error).message ?? err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <SettingsGroup title="TerminalDeck">
        <SettingRow label={t('Version')}>
          <span className="setting-value">{window.td.appVersion}</span>
          <button onClick={() => setNotes(true)}>{t('What’s new')}</button>
        </SettingRow>
        <SettingRow
          label={t('Updates')}
          hint={t(
            'Asked for on the hour while the application runs, and at every start. This is the same question asked now, for when a release has just gone out.'
          )}
          note={checked || undefined}
        >
          <button onClick={checkForUpdate} disabled={checking}>
            {checking ? t('Checking…') : t('Check for updates')}
          </button>
        </SettingRow>
      </SettingsGroup>

      {notes && (
        <WhatsNewDialog
          releases={recentNotes(language, window.td.appVersion)}
          onClose={() => setNotes(false)}
        />
      )}
    </>
  )
}
