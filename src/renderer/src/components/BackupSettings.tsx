import { useState } from 'react'
import type { ImportSummary } from '../../../shared/types'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import Hint from './Hint'

export default function BackupSettings(): JSX.Element {
  const t = useT()
  const loadStore = useStore((s) => s.loadStore)
  const loadSnippets = useStore((s) => s.loadSnippets)
  const loadInventory = useStore((s) => s.loadInventory)
  const loadCollections = useStore((s) => s.loadCollections)
  const loadCredentials = useStore((s) => s.loadCredentials)

  // Off by default: an export leaves the machine and the OS account that
  // protects the vault, so including credentials must be a deliberate choice.
  const [includeSecrets, setIncludeSecrets] = useState(false)
  const [exportPassword, setExportPassword] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function doExport(): Promise<void> {
    setError(null)
    setDone(null)
    // Longer than the vault's own minimum: this file can be copied off the
    // machine and attacked offline for as long as someone cares to.
    if (includeSecrets && exportPassword.length < 12) {
      setError(t('Use at least 12 characters — this file can be attacked offline'))
      return
    }
    try {
      const path = await window.td.backup.exportToFile(
        includeSecrets,
        includeSecrets ? exportPassword : undefined
      )
      if (path) {
        setDone(t('Exported to {path}', { path }))
        setExportPassword('')
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function doImport(): Promise<void> {
    setError(null)
    setDone(null)
    try {
      const summary: ImportSummary | undefined = await window.td.backup.importFromFile(
        importPassword || undefined
      )
      if (!summary) return
      await Promise.all([
        loadStore(),
        loadSnippets(),
        loadInventory(),
        loadCollections(),
        loadCredentials()
      ])
      setImportPassword('')
      // One sentence rather than five fragments: the numbers land where each
      // language puts them, and a plural rule that differs is one entry to fix.
      setDone(
        t(
          'Imported {sessions} sessions, {groups} groups, {snippets} snippets, {collections} collections, {repositories} repositories',
          {
            sessions: summary.sessions,
            groups: summary.groups,
            snippets: summary.snippets,
            collections: summary.collections,
            repositories: summary.inventorySources
          }
        ) +
          // Two clauses of their own rather than more placeholders in the
          // sentence above: both are regularly zero, and "0 saved accounts" is
          // a line about something that did not happen.
          (summary.credentials > 0
            ? t(', {accounts} saved accounts', { accounts: summary.credentials })
            : '') +
          (summary.secrets > 0
            ? t(', and {secrets} credentials', { secrets: summary.secrets })
            : '')
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <h3 className="settings-heading">
        <Hint label={t('Export')}>
          {t(
            'Writes sessions, groups, snippets and inventory sources to one file. Terminal appearance and trusted host keys stay on this machine.'
          )}
        </Hint>
      </h3>

      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={includeSecrets}
          onChange={(e) => setIncludeSecrets(e.target.checked)}
        />
        {t('Include saved credentials')}
      </label>

      {includeSecrets && (
        <>
          <label>
            {t('Password for the exported credentials')}
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
            />
          </label>
          <p className="settings-note">
            {t(
              'Credentials are re-encrypted with AES-256-GCM under this password — the same scheme the vault uses — and never written in the clear. A separate password is used so the file can travel without handing over your master password.'
            )}
          </p>
          <p className="settings-note">
            {t(
              'Treat the file as a secret all the same. Unlike the vault it leaves this machine and the account protecting it, and can be attacked offline for as long as someone likes, so use a long password and delete the file once the move is done. Lose the password and those credentials are unrecoverable.'
            )}
          </p>
        </>
      )}

      <div>
        <button className="primary" onClick={doExport}>
          {t('Export…')}
        </button>
      </div>

      <h3 className="settings-heading">
        <Hint label={t('Import')}>
          {t(
            'Entries are matched by id: an existing one is replaced, a new one is added, and nothing already here is deleted.'
          )}
        </Hint>
      </h3>
      <label>
        {t('Password, if the file contains credentials')}
        <input
          type="password"
          value={importPassword}
          onChange={(e) => setImportPassword(e.target.value)}
        />
      </label>
      <div>
        <button onClick={doImport}>{t('Import…')}</button>
      </div>

      {error && <span className="error-text">{error}</span>}
      {done && <span className="success-text">{done}</span>}
    </>
  )
}
