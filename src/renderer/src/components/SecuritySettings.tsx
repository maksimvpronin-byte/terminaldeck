import { useEffect, useState } from 'react'
import Hint from './Hint'
import { useStore } from '../state/store'
import { useT } from '../i18n'

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
 * A list of what has been trusted, for a machine that has trusted a lot.
 *
 * It used to draw every entry with a button beside it. That reads as a list
 * until somebody has three thousand hosts, at which point it is neither a list
 * nor anything else: nobody scrolls three thousand rows to find one, and the
 * setting screen it lives on becomes unusable for everything else on it.
 *
 * So: a count, a filter, and the first twenty matches. Finding one entry is a
 * search, which is what it always was — the scrolling was never how anybody
 * did it.
 */
function TrustedList({
  entries,
  empty,
  onForget
}: {
  entries: TrustedHost[]
  empty: string
  onForget: (host: string) => void
}): JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')

  if (entries.length === 0) return <p className="settings-note">{empty}</p>

  const needle = query.trim().toLowerCase()
  const found = needle
    ? entries.filter(
        (e) =>
          e.host.toLowerCase().includes(needle) || e.fingerprint.toLowerCase().includes(needle)
      )
    : entries
  const shown = found.slice(0, SHOWN)

  return (
    <>
      <div className="form-row">
        <input
          style={{ flex: 1 }}
          value={query}
          placeholder={t('Filter by host or fingerprint…')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
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
    </>
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
      <TrustedList
        entries={hosts}
        empty={t('No hosts trusted yet.')}
        onForget={forget}
      />

      <h3 className="settings-heading">
        <Hint label={t('Trusted certificates')}>
          {t(
            'Desktop sessions only, and only certificates this machine could not verify on its own — a gateway or a host that issues its own. One signed by a public authority is checked against the system and never listed here, so a routine reissue changes nothing.'
          )}
        </Hint>
      </h3>
      <TrustedList
        entries={certificates}
        empty={t('No certificates trusted by hand.')}
        onForget={forgetCertificate}
      />
    </>
  )
}
