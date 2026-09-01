import { useEffect, useState } from 'react'
import Hint from './Hint'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import ModalBackdrop from './ModalBackdrop'

interface TrustedHost {
  host: string
  fingerprint: string
}

/**
 * How long the application may sit untouched before it locks itself, in
 * minutes. Zero never locks.
 *
 * A short list rather than a number box: the useful answers are few, and a
 * field that accepts 7 also accepts 0.5 and 100000, each of which is a way to
 * turn the lock off without meaning to.
 *
 * Eight hours is on the list because a working day is the interval people
 * actually want — long enough that the vault is not asking again after lunch,
 * and still an end to it, which "never" is not.
 */
const LOCK_DELAYS = [0, 1, 5, 15, 30, 60, 120, 480]

/** How many rows are worth drawing before a filter is the better answer. */
const SHOWN = 20

/**
 * What has been trusted, and the one thing anybody does with it.
 *
 * Not on the settings screen. A machine that has met three thousand hosts has
 * three thousand of these, and no arrangement of them belongs on a page whose
 * other business is a password field and a lock delay — a filtered twenty is
 * still twenty rows in front of everything else, for a list somebody opens when
 * a server has been rebuilt and not otherwise.
 *
 * So the screen carries a count and a button, and this is what the button
 * opens: a filter, the first twenty matches, and a note saying how many are
 * left.
 */
function TrustedDialog({
  title,
  entries,
  onForget,
  onClose
}: {
  title: string
  entries: TrustedHost[]
  onForget: (host: string) => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')

  const needle = query.trim().toLowerCase()
  const found = needle
    ? entries.filter(
        (e) =>
          e.host.toLowerCase().includes(needle) || e.fingerprint.toLowerCase().includes(needle)
      )
    : entries
  const shown = found.slice(0, SHOWN)

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{title}</h2>
        <input
          autoFocus
          value={query}
          placeholder={t('Filter by host or fingerprint…')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="settings-note">
          {needle
            ? t('{found} of {total} match', { found: found.length, total: entries.length })
            : t('{total} trusted', { total: entries.length })}
        </p>

        <div className="known-hosts-list">
          {shown.map((e) => (
            <div className="known-host-row" key={e.host}>
              <div className="known-host-name">{e.host}</div>
              <div className="known-host-fp">{e.fingerprint}</div>
              <button onClick={() => onForget(e.host)}>{t('Forget')}</button>
            </div>
          ))}
        </div>
        {found.length > shown.length && (
          <p className="settings-note">
            {t('{rest} more — narrow the filter to reach them', {
              rest: found.length - shown.length
            })}
          </p>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            {t('Done')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}

/** The count, and the way in. */
function TrustedSummary({
  entries,
  empty,
  onOpen
}: {
  entries: TrustedHost[]
  empty: string
  onOpen: () => void
}): JSX.Element {
  const t = useT()
  if (entries.length === 0) return <p className="settings-note">{empty}</p>
  return (
    <p className="settings-note action-note">
      {t('{total} trusted', { total: entries.length })}
      <button onClick={onOpen}>{t('Review…')}</button>
    </p>
  )
}

export default function SecuritySettings(): JSX.Element {
  const t = useT()
  const lockAfterMinutes = useStore((s) => s.settings.lockAfterMinutes)
  const updateSettings = useStore((s) => s.updateSettings)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [pwDone, setPwDone] = useState(false)
  const [reviewing, setReviewing] = useState<'hosts' | 'certificates' | null>(null)
  const [hosts, setHosts] = useState<TrustedHost[]>([])
  const [certificates, setCertificates] = useState<TrustedHost[]>([])

  async function refreshHosts(): Promise<void> {
    setHosts(await window.td.knownHosts.list())
  }

  async function refreshCertificates(): Promise<void> {
    setCertificates(await window.td.knownCertificates.list())
  }

  useEffect(() => {
    refreshHosts()
    refreshCertificates()
  }, [])

  async function changePassword(): Promise<void> {
    setPwError(null)
    setPwDone(false)
    if (next.length < 8) {
      setPwError(t('New password must be at least 8 characters'))
      return
    }
    if (next !== confirm) {
      setPwError(t('New passwords do not match'))
      return
    }
    const res = await window.td.vault.changePassword(current, next)
    if (!res.ok) {
      setPwError(res.error ?? t('Could not change the password'))
      return
    }
    setCurrent('')
    setNext('')
    setConfirm('')
    setPwDone(true)
  }

  async function forget(host: string): Promise<void> {
    await window.td.knownHosts.remove(host)
    refreshHosts()
  }

  async function forgetCertificate(host: string): Promise<void> {
    await window.td.knownCertificates.remove(host)
    refreshCertificates()
  }

  return (
    <>
      <h3 className="settings-heading">{t('Locking')}</h3>
      <label>
        <Hint label={t('Lock after this long untouched')}>
          {t(
            'Untouched means no typing, no pointer and no scrolling anywhere in the window, a terminal included. Locking closes nothing: sessions stay open and keep running, and the vault stops answering for stored passwords until the master password is given again.'
          )}
        </Hint>
        <select
          value={String(lockAfterMinutes)}
          onChange={(e) => updateSettings({ lockAfterMinutes: Number(e.target.value) })}
        >
          {LOCK_DELAYS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes === 0
                ? t('Never — stay unlocked')
                : minutes < 60
                  ? `${minutes} ${t('minutes')}`
                  : `${minutes / 60} ${t('hours')}`}
            </option>
          ))}
        </select>
      </label>

      <h3 className="settings-heading">
        <Hint label={t('Master password')}>
          {t(
            'Every stored secret is re-encrypted under the new password. Nothing is lost, and the password itself is never written to disk.'
          )}
        </Hint>
      </h3>
      <label>
        {t('Current password')}
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <div className="form-row">
        <label>
          {t('New password')}
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          {t('Confirm')}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      </div>
      {pwError && <span className="error-text">{pwError}</span>}
      {pwDone && <span className="success-text">{t('Master password changed.')}</span>}
      <div>
        <button className="primary" onClick={changePassword} disabled={!current || !next}>
          {t('Change password')}
        </button>
      </div>

      <h3 className="settings-heading">
        <Hint label={t('Session logs')}>
          {t(
            'Sessions with “Log session output to file” enabled write here. The transcript contains everything the terminal showed, so treat it as sensitive.'
          )}
        </Hint>
      </h3>
      <div>
        <button onClick={() => window.td.logs.reveal()}>{t('Open logs folder')}</button>
      </div>

      <h3 className="settings-heading">
        <Hint label={t('Trusted host keys')}>
          {t(
            'Removing an entry makes TerminalDeck ask again on the next connection. Do that when a server was legitimately rebuilt and its key changed.'
          )}
        </Hint>
      </h3>
      <TrustedSummary
        entries={hosts}
        empty={t('No hosts trusted yet.')}
        onOpen={() => setReviewing('hosts')}
      />

      <h3 className="settings-heading">
        <Hint label={t('Trusted certificates')}>
          {t(
            'Desktop sessions only, and only certificates this machine could not verify on its own — a gateway or a host that issues its own. One signed by a public authority is checked against the system and never listed here, so a routine reissue changes nothing.'
          )}
        </Hint>
      </h3>
      <TrustedSummary
        entries={certificates}
        empty={t('No certificates trusted by hand.')}
        onOpen={() => setReviewing('certificates')}
      />

      {reviewing === 'hosts' && (
        <TrustedDialog
          title={t('Trusted host keys')}
          entries={hosts}
          onForget={forget}
          onClose={() => setReviewing(null)}
        />
      )}
      {reviewing === 'certificates' && (
        <TrustedDialog
          title={t('Trusted certificates')}
          entries={certificates}
          onForget={forgetCertificate}
          onClose={() => setReviewing(null)}
        />
      )}
    </>
  )
}
