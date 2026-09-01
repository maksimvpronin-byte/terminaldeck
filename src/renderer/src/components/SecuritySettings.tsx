import { useEffect, useState } from 'react'
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
 */
const LOCK_DELAYS = [0, 1, 5, 15, 30, 60, 120]

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
        {t('Lock after this long untouched')}
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
      <p className="settings-note">
        {t(
          'Untouched means no typing, no pointer and no scrolling anywhere in the window, a terminal included. Locking closes nothing: sessions stay open and keep running, and the vault stops answering for stored passwords until the master password is given again.'
        )}
      </p>

      <h3 className="settings-heading">{t('Master password')}</h3>
      <p className="settings-note">
        {t(
          'Every stored secret is re-encrypted under the new password. Nothing is lost, and the password itself is never written to disk.'
        )}
      </p>
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

      <h3 className="settings-heading">{t('Session logs')}</h3>
      <p className="settings-note">
        {t(
          'Sessions with “Log session output to file” enabled write here. The transcript contains everything the terminal showed, so treat it as sensitive.'
        )}
      </p>
      <div>
        <button onClick={() => window.td.logs.reveal()}>{t('Open logs folder')}</button>
      </div>

      <h3 className="settings-heading">{t('Trusted host keys')}</h3>
      <p className="settings-note">
        {t(
          'Removing an entry makes TerminalDeck ask again on the next connection. Do that when a server was legitimately rebuilt and its key changed.'
        )}
      </p>
      {hosts.length === 0 ? (
        <p className="settings-note">{t('No hosts trusted yet.')}</p>
      ) : (
        <div className="known-hosts-list">
          {hosts.map((h) => (
            <div className="known-host-row" key={h.host}>
              <div className="known-host-name">{h.host}</div>
              <div className="known-host-fp">{h.fingerprint}</div>
              <button onClick={() => forget(h.host)}>{t('Forget')}</button>
            </div>
          ))}
        </div>
      )}

      <h3 className="settings-heading">{t('Trusted certificates')}</h3>
      <p className="settings-note">
        {t(
          'Desktop sessions only, and only certificates this machine could not verify on its own — a gateway or a host that issues its own. One signed by a public authority is checked against the system and never listed here, so a routine reissue changes nothing.'
        )}
      </p>
      {certificates.length === 0 ? (
        <p className="settings-note">{t('No certificates trusted by hand.')}</p>
      ) : (
        <div className="known-hosts-list">
          {certificates.map((c) => (
            <div className="known-host-row" key={c.host}>
              <div className="known-host-name">{c.host}</div>
              <div className="known-host-fp">{c.fingerprint}</div>
              <button onClick={() => forgetCertificate(c.host)}>{t('Forget')}</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
