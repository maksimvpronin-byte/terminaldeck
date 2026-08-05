import { useState } from 'react'
import type { ImportSummary } from '../../../shared/types'
import { useStore } from '../state/store'

export default function BackupSettings(): JSX.Element {
  const loadStore = useStore((s) => s.loadStore)
  const loadSnippets = useStore((s) => s.loadSnippets)
  const loadInventory = useStore((s) => s.loadInventory)

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
      setError('Use at least 12 characters — this file can be attacked offline')
      return
    }
    try {
      const path = await window.td.backup.exportToFile(
        includeSecrets,
        includeSecrets ? exportPassword : undefined
      )
      if (path) {
        setDone(`Exported to ${path}`)
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
      await Promise.all([loadStore(), loadSnippets(), loadInventory()])
      setImportPassword('')
      setDone(
        `Imported ${summary.sessions} sessions, ${summary.groups} groups, ` +
          `${summary.snippets} snippets, ${summary.inventorySources} repositories` +
          (summary.secrets > 0 ? `, ${summary.secrets} credentials` : '')
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <>
      <h3 className="settings-heading">Export</h3>
      <p className="settings-note">
        Writes sessions, groups, snippets and inventory sources to one file. Terminal appearance
        and trusted host keys stay on this machine.
      </p>

      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={includeSecrets}
          onChange={(e) => setIncludeSecrets(e.target.checked)}
        />
        Include saved credentials
      </label>

      {includeSecrets && (
        <>
          <label>
            Password for the exported credentials
            <input
              type="password"
              value={exportPassword}
              onChange={(e) => setExportPassword(e.target.value)}
            />
          </label>
          <p className="settings-note">
            Credentials are re-encrypted with AES-256-GCM under this password — the same scheme
            the vault uses — and never written in the clear. A separate password is used so the
            file can travel without handing over your master password.
          </p>
          <p className="settings-note">
            Treat the file as a secret all the same. Unlike the vault it leaves this machine and
            the account protecting it, and can be attacked offline for as long as someone likes,
            so use a long password and delete the file once the move is done. Lose the password
            and those credentials are unrecoverable.
          </p>
        </>
      )}

      <div>
        <button className="primary" onClick={doExport}>
          Export…
        </button>
      </div>

      <h3 className="settings-heading">Import</h3>
      <p className="settings-note">
        Entries are matched by id: an existing one is replaced, a new one is added, and nothing
        already here is deleted.
      </p>
      <label>
        Password, if the file contains credentials
        <input
          type="password"
          value={importPassword}
          onChange={(e) => setImportPassword(e.target.value)}
        />
      </label>
      <div>
        <button onClick={doImport}>Import…</button>
      </div>

      {error && <span className="error-text">{error}</span>}
      {done && <span className="success-text">{done}</span>}
    </>
  )
}
