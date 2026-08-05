import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AuthMethod, PortForwardRule, SessionProfile } from '../../../shared/types'
import { resolveAuth, inheritedFrom } from '../../../shared/authResolution'
import { groupPath } from '../../../shared/groups'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import ModalBackdrop from './ModalBackdrop'

interface Props {
  initial?: SessionProfile
  defaultGroupId?: string | null
  onClose: () => void
}

function blank(defaultGroupId: string | null): SessionProfile {
  const now = Date.now()
  // Auth fields stay unset so a new session inherits from its group by default.
  return {
    id: nanoid(),
    name: '',
    host: '',
    groupId: defaultGroupId,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: now,
    updatedAt: now
  }
}

export default function SessionDialog({ initial, defaultGroupId = null, onClose }: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const upsertSession = useStore((s) => s.upsertSession)

  const [profile, setProfile] = useState<SessionProfile>(initial ?? blank(defaultGroupId))
  const [secret, setSecret] = useState('')
  const [tagsInput, setTagsInput] = useState(profile.tags.join(', '))
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SessionProfile>(key: K, value: SessionProfile[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  // What this session ends up with once inheritance is applied.
  const effective = resolveAuth(profile, profile.groupId, groups)
  const inheritNote = (key: Parameters<typeof inheritedFrom>[3]): string => {
    const source = inheritedFrom(profile, profile.groupId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  function addForward(): void {
    const rule: PortForwardRule = { id: nanoid(), type: 'local', srcHost: '127.0.0.1', srcPort: 8080, dstHost: '127.0.0.1', dstPort: 80 }
    set('portForwards', [...profile.portForwards, rule])
  }

  function updateForward(id: string, patch: Partial<PortForwardRule>): void {
    set(
      'portForwards',
      profile.portForwards.map((r) => (r.id === id ? { ...r, ...patch } : r))
    )
  }

  function removeForward(id: string): void {
    set('portForwards', profile.portForwards.filter((r) => r.id !== id))
  }

  async function submit(): Promise<void> {
    if (!profile.name.trim() || !profile.host.trim()) {
      setError('Name and host are required')
      return
    }
    if (!effective.username.trim()) {
      setError('Username is not set here and none is inherited from a group')
      return
    }
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const toSave: SessionProfile = { ...profile, tags, updatedAt: Date.now() }
    const secretToStore = effective.authMethod === 'agent' ? undefined : secret || undefined
    await upsertSession(toSave, secretToStore)
    onClose()
  }

  const otherSessions = sessions.filter((s) => s.id !== profile.id)

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit session' : 'New session'}</h2>

        <label>
          Name
          <input value={profile.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <div className="form-row">
          <label style={{ flex: 3 }}>
            Host
            <input value={profile.host} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              type="number"
              value={profile.port ?? ''}
              placeholder={String(effective.port)}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        {profile.groupId && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={profile.inheritAuth !== false}
              onChange={(e) => set('inheritAuth', e.target.checked ? undefined : false)}
            />
            Inherit connection settings from the group
          </label>
        )}

        <label>
          Username
          <input
            value={profile.username ?? ''}
            placeholder={inheritNote('username') || 'required'}
            onChange={(e) => set('username', e.target.value)}
          />
        </label>

        <label>
          Auth method
          <select
            value={profile.authMethod ?? ''}
            onChange={(e) => set('authMethod', (e.target.value || undefined) as AuthMethod)}
          >
            <option value="">Inherit ({effective.authMethod})</option>
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>

        {effective.authMethod === 'password' && (
          <label>
            Password{' '}
            {inheritNote('secretRef')
              ? `(blank keeps the one ${inheritNote('secretRef')})`
              : '(leave blank to keep existing)'}
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        )}

        {effective.authMethod === 'privateKey' && (
          <>
            <div className="form-row">
              <label style={{ flex: 1 }}>
                Private key file
                <input
                  readOnly
                  value={profile.privateKeyPath ?? ''}
                  placeholder={inheritNote('privateKeyPath') || 'No file selected'}
                />
              </label>
              <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
                Browse…
              </button>
            </div>
            <label>
              Passphrase (leave blank if none / to keep existing)
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          </>
        )}

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={effective.agentForward}
            onChange={(e) => set('agentForward', e.target.checked)}
          />
          Forward SSH agent to remote host
        </label>

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={profile.logToFile}
            onChange={(e) => set('logToFile', e.target.checked)}
          />
          Log session output to file
        </label>

        <label>
          Jump host (ProxyJump)
          <select
            value={profile.jumpHostId ?? ''}
            onChange={(e) => set('jumpHostId', e.target.value || null)}
          >
            <option value="">
              {inheritNote('jumpHostId')
                ? `Inherited (${sessions.find((s) => s.id === effective.jumpHostId)?.name ?? 'none'})`
                : 'None'}
            </option>
            {otherSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Group
          <select value={profile.groupId ?? ''} onChange={(e) => set('groupId', e.target.value || null)}>
            <option value="">(no group)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(g.id, groups)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Colour
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!profile.color ? 'selected' : ''}`}
              title="No colour"
              onClick={() => set('color', undefined)}
            />
            {SESSION_COLOURS.map((c) => (
              <button
                type="button"
                key={c.value}
                className={`swatch ${profile.color === c.value ? 'selected' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                onClick={() => set('color', c.value)}
              />
            ))}
          </div>
        </label>

        <label>
          Tags (comma separated)
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
        </label>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>Port forwards</span>
            <button onClick={addForward}>+ Add</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {profile.portForwards.map((r) => (
              <div className="pf-rule" key={r.id}>
                <select value={r.type} onChange={(e) => updateForward(r.id, { type: e.target.value as PortForwardRule['type'] })}>
                  <option value="local">Local</option>
                  <option value="remote">Remote</option>
                  <option value="dynamic">Dynamic (SOCKS)</option>
                </select>
                <input
                  placeholder="src host"
                  value={r.srcHost}
                  onChange={(e) => updateForward(r.id, { srcHost: e.target.value })}
                  style={{ width: 90 }}
                />
                <input
                  type="number"
                  placeholder="src port"
                  value={r.srcPort}
                  onChange={(e) => updateForward(r.id, { srcPort: Number(e.target.value) })}
                  style={{ width: 70 }}
                />
                {r.type !== 'dynamic' && (
                  <>
                    <span>→</span>
                    <input
                      placeholder="dst host"
                      value={r.dstHost ?? ''}
                      onChange={(e) => updateForward(r.id, { dstHost: e.target.value })}
                      style={{ width: 90 }}
                    />
                    <input
                      type="number"
                      placeholder="dst port"
                      value={r.dstPort ?? 0}
                      onChange={(e) => updateForward(r.id, { dstPort: Number(e.target.value) })}
                      style={{ width: 70 }}
                    />
                  </>
                )}
                <button onClick={() => removeForward(r.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
