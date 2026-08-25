import { useEffect, useState } from 'react'

interface TrustedHost {
  host: string
  fingerprint: string
}

export default function SecuritySettings(): JSX.Element {
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
      setPwError('New password must be at least 8 characters')
      return
    }
    if (next !== confirm) {
      setPwError('New passwords do not match')
      return
    }
    const res = await window.td.vault.changePassword(current, next)
    if (!res.ok) {
      setPwError(res.error ?? 'Could not change the password')
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
      <h3 className="settings-heading">Master password</h3>
      <p className="settings-note">
        Every stored secret is re-encrypted under the new password. Nothing is lost, and the
        password itself is never written to disk.
      </p>
      <label>
        Current password
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <div className="form-row">
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          Confirm
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
      </div>
      {pwError && <span className="error-text">{pwError}</span>}
      {pwDone && <span className="success-text">Master password changed.</span>}
      <div>
        <button className="primary" onClick={changePassword} disabled={!current || !next}>
          Change password
        </button>
      </div>

      <h3 className="settings-heading">Session logs</h3>
      <p className="settings-note">
        Sessions with “Log session output to file” enabled write here. The transcript contains
        everything the terminal showed, so treat it as sensitive.
      </p>
      <div>
        <button onClick={() => window.td.logs.reveal()}>Open logs folder</button>
      </div>

      <h3 className="settings-heading">Trusted host keys</h3>
      <p className="settings-note">
        Removing an entry makes TerminalDeck ask again on the next connection. Do that when a
        server was legitimately rebuilt and its key changed.
      </p>
      {hosts.length === 0 ? (
        <p className="settings-note">No hosts trusted yet.</p>
      ) : (
        <div className="known-hosts-list">
          {hosts.map((h) => (
            <div className="known-host-row" key={h.host}>
              <div className="known-host-name">{h.host}</div>
              <div className="known-host-fp">{h.fingerprint}</div>
              <button onClick={() => forget(h.host)}>Forget</button>
            </div>
          ))}
        </div>
      )}

      <h3 className="settings-heading">Trusted certificates</h3>
      <p className="settings-note">
        Desktop sessions only, and only certificates this machine could not verify on its own —
        a gateway or a host that issues its own. One signed by a public authority is checked
        against the system and never listed here, so a routine reissue changes nothing.
      </p>
      {certificates.length === 0 ? (
        <p className="settings-note">No certificates trusted by hand.</p>
      ) : (
        <div className="known-hosts-list">
          {certificates.map((c) => (
            <div className="known-host-row" key={c.host}>
              <div className="known-host-name">{c.host}</div>
              <div className="known-host-fp">{c.fingerprint}</div>
              <button onClick={() => forgetCertificate(c.host)}>Forget</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
