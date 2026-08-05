import { useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import type { SessionProfile, SshConfigHost } from '../../../shared/types'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'

export default function ImportSshConfigDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const upsertSession = useStore((s) => s.upsertSession)

  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    try {
      const chosen = hosts.filter((h) => picked.has(h.alias))
      const now = Date.now()
      // First pass: create every profile so ProxyJump can be linked afterwards.
      const created = new Map<string, SessionProfile>()
      for (const h of chosen) {
        const profile: SessionProfile = {
          id: nanoid(),
          name: h.alias,
          host: h.hostname,
          // Only what the config actually stated; the rest is left to inherit.
          port: h.port === 22 ? undefined : h.port,
          username: h.user,
          authMethod: h.identityFile ? 'privateKey' : 'agent',
          privateKeyPath: h.identityFile,
          groupId: null,
          tags: ['ssh-config'],
          logToFile: false,
          portForwards: [],
          createdAt: now,
          updatedAt: now
        }
        created.set(h.alias, profile)
      }
      // Second pass: resolve ProxyJump against imported or already-saved profiles.
      for (const h of chosen) {
        if (!h.proxyJump) continue
        const jumpAlias = h.proxyJump.replace(/^.*@/, '').split(':')[0]
        const jump = created.get(jumpAlias) ?? sessions.find((s) => s.name === jumpAlias)
        if (jump) created.get(h.alias)!.jumpHostId = jump.id
      }
      for (const profile of created.values()) await upsertSession(profile)
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
        <h2>Import from ~/.ssh/config</h2>

        {hosts === null && <p>Reading ~/.ssh/config…</p>}
        {hosts !== null && hosts.length === 0 && (
          <p>No usable Host entries found in ~/.ssh/config.</p>
        )}

        {hosts !== null && hosts.length > 0 && (
          <>
            <p>
              Selected hosts become TerminalDeck sessions. Passwords aren’t stored in ssh config, so
              key-based entries use their IdentityFile and the rest fall back to the SSH agent.
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

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            onClick={doImport}
            disabled={busy || picked.size === 0}
          >
            Import {picked.size > 0 ? `(${picked.size})` : ''}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
