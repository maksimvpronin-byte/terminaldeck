import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import type { SshConfigHost } from '../../../shared/types'
import { planSshImport, type SshImportProblem } from '../../../shared/sshImport'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

export default function ImportSshConfigDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const upsertSessions = useStore((s) => s.upsertSessions)

  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problems, setProblems] = useState<SshImportProblem[]>([])

  useEffect(() => {
    window.td.importer
      .sshConfigHosts()
      .then((list) => {
        setHosts(list)
        // Pre-select everything that isn't already saved under the same name.
        const existing = new Set(sessions.map((s) => s.name))
        setPicked(new Set(list.filter((h) => !existing.has(h.alias)).map((h) => h.alias)))
      })
      .catch((err) => setError((err as Error).message))
    // Reads ~/.ssh/config once, when the dialog opens, and pre-selects against
    // the sessions as they stand at that moment. Re-running on every change to
    // `sessions` would undo the ticks the user has just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggle(alias: string): void {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(alias)) next.delete(alias)
      else next.add(alias)
      return next
    })
  }

  async function doImport(): Promise<void> {
    if (!hosts) return
    setBusy(true)
    setError(null)
    setProblems([])
    try {
      const chosen = hosts.filter((h) => picked.has(h.alias))
      // Every route is checked before anything is written, and then everything
      // is written at once: a failure halfway used to leave the first hosts
      // saved — one of them pointing at a jump host that never was — and trying
      // again added them a second time under new ids.
      const plan = planSshImport(chosen, sessions, groups, nanoid, Date.now())
      if (!plan.ok) {
        setProblems(plan.problems)
        return
      }
      await upsertSessions(plan.profiles)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Import from ~/.ssh/config')}</h2>

        {hosts === null && <p>{t('Reading ~/.ssh/config…')}</p>}
        {hosts !== null && hosts.length === 0 && (
          <p>{t('No usable Host entries found in ~/.ssh/config.')}</p>
        )}

        {hosts !== null && hosts.length > 0 && (
          <>
            <p>
              {t(
                'Selected hosts become TerminalDeck sessions. Passwords aren’t stored in ssh config, so key-based entries use their IdentityFile and the rest fall back to the SSH agent.'
              )}
            </p>
            <div className="import-list">
              {hosts.map((h) => (
                <label className="import-row" key={h.alias}>
                  <input
                    type="checkbox"
                    checked={picked.has(h.alias)}
                    onChange={() => toggle(h.alias)}
                  />
                  <span className="import-alias">{h.alias}</span>
                  <span className="import-detail">
                    {h.user ? `${h.user}@` : ''}
                    {h.hostname}
                    {h.port !== 22 ? `:${h.port}` : ''}
                    {h.proxyJump ? ` via ${h.proxyJump}` : ''}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        {problems.length > 0 && (
          <div className="error-text">
            <p>
              {t(
                'Nothing was imported. These hosts go through jump hosts that are not here — tick them too, or untick these:'
              )}
            </p>
            <ul>
              {problems.map((p) => (
                <li key={`${p.alias}-${p.hop}`}>
                  {p.reason === 'missing'
                    ? t('{alias}: its jump host {hop} is neither selected nor saved', {
                        alias: p.alias,
                        hop: p.hop
                      })
                    : t('{alias}: {hop} is not reached through the jump host before it', {
                        alias: p.alias,
                        hop: p.hop
                      })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={doImport} disabled={busy || picked.size === 0}>
            {t('Import')} {picked.size > 0 ? `(${picked.size})` : ''}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
