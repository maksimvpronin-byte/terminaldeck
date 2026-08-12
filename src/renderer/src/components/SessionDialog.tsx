import { useState } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppearanceDefaults,
  AuthMethod,
  PortForwardRule,
  SessionProfile
} from '../../../shared/types'
import { resolveAuth, inheritedFrom, sourceOf } from '../../../shared/authResolution'
import { isSet } from '../../../shared/overrides'
import {
  appearanceSource,
  inheritedAppearance,
  resolveAppearance
} from '../../../shared/appearance'
import { groupPath } from '../../../shared/groups'
import { PROTOCOLS, protocolOf, traitsOf, type Protocol } from '../../../shared/protocols'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
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
  const settings = useStore((s) => s.settings)
  const upsertSession = useStore((s) => s.upsertSession)

  const [profile, setProfile] = useState<SessionProfile>(initial ?? blank(defaultGroupId))
  const [secret, setSecret] = useState('')
  // A host that holds a credential of its own keeps using it whatever group it
  // is moved into, so dropping it has to be something the dialog can do.
  const [forgetSecret, setForgetSecret] = useState(false)
  const [tagsInput, setTagsInput] = useState(profile.tags.join(', '))
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SessionProfile>(key: K, value: SessionProfile[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  /**
   * Choosing "inherit" means inheriting the credential too, so the host's own is
   * dropped in the same move — leaving it behind is what makes a group password
   * look ignored. Choosing a method again keeps it, and the note below says
   * which way it currently stands, so neither is silent.
   */
  function chooseInheritance(inherit: boolean): void {
    if (ownSecret) setForgetSecret(inherit)
  }

  // What this session ends up with once inheritance is applied. Pending changes
  // count, so ticking "forget" immediately shows what it would inherit instead.
  const pending: SessionProfile = forgetSecret ? { ...profile, secretRef: undefined } : profile
  const effective = resolveAuth(pending, pending.groupId, groups)
  const inheritNote = (key: Parameters<typeof inheritedFrom>[3]): string => {
    const source = inheritedFrom(pending, pending.groupId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownSecret = isSet(profile.secretRef)

  const appearance = resolveAppearance(profile, profile.groupId, groups, settings)
  const inheritedLook = inheritedAppearance(profile, profile.groupId, groups, settings)
  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const source = appearanceSource(profile, profile.groupId, groups, key)
    return source ? `the group ${source.name}` : 'Settings'
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
    const typed = effective.authMethod === 'agent' ? '' : secret
    // A password typed in now beats the "forget" tick — it is the later answer.
    const secretToStore = typed || (forgetSecret ? null : undefined)
    await upsertSession(toSave, secretToStore)
    onClose()
  }

  const otherSessions = sessions.filter((s) => s.id !== profile.id)

  const secretHint =
    ownSecret && !forgetSecret
      ? '(saved on this host — it overrides the group)'
      : inheritNote('secretRef')
        ? `(blank keeps the one ${inheritNote('secretRef')})`
        : '(leave blank to keep existing)'

  /**
   * Each field is inherited on its own, so a key file and the passphrase used
   * with it can end up coming from different places — a passphrase left over
   * from password auth, say, silently applied to a group's key.
   */
  const keyFrom = sourceOf(pending, pending.groupId, groups, 'privateKeyPath')
  const passphraseFrom = sourceOf(pending, pending.groupId, groups, 'secretRef')
  const levelName = (level: 'self' | { name: string }): string =>
    level === 'self' ? 'this host' : level.name
  const splitCredential =
    effective.authMethod === 'privateKey' && keyFrom && passphraseFrom && keyFrom !== passphraseFrom

  /**
   * Only a credential the host holds itself can be dropped here; an inherited one
   * belongs to the group that states it. Saying so matters: without it a wrong
   * group password looks like it was used when the host's own one was.
   */
  const ownSecretNote = ownSecret ? (
    <p className="settings-note">
      {forgetSecret
        ? `On save this host forgets its own ${
            effective.authMethod === 'privateKey' ? 'passphrase' : 'password'
          } and uses ${
            inheritNote('secretRef')
              ? `the one ${inheritNote('secretRef')}`
              : 'whatever it is asked for on connect'
          }.`
        : `This host has a ${
            effective.authMethod === 'privateKey' ? 'passphrase' : 'password'
          } of its own, and the nearest value wins: moving it into a group leaves the group's unused.`}{' '}
      <button type="button" onClick={() => setForgetSecret(!forgetSecret)}>
        {forgetSecret ? 'Keep it' : 'Forget it'}
      </button>
    </p>
  ) : null

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit session' : 'New session'}</h2>

        <label>
          Name
          <input value={profile.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <div className="form-row">
          <label style={{ flex: 1 }}>
            Protocol
            <select
              value={protocolOf(profile)}
              onChange={(e) => set('protocol', e.target.value as Protocol)}
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {traitsOf(p).label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 3 }}>
            Host
            <input value={profile.host} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              type="number"
              value={profile.port ?? ''}
              // The protocol's own default, so switching to RDP offers 3389
              // rather than the 22 an SSH chain would have inherited.
              placeholder={String(
                protocolOf(profile) === 'ssh' ? effective.port : traitsOf(protocolOf(profile)).port
              )}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        {protocolOf(profile) !== 'ssh' && (
          <p className="settings-note warning-note">
            {traitsOf(protocolOf(profile)).label} sessions open a desktop rather than a shell, so
            the file browser, port forwarding, monitoring and broadcast do not apply to them. The
            desktop itself is not carried yet — the proxy that speaks it is still to come.
          </p>
        )}

        {profile.groupId && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={profile.inheritAuth !== false}
              onChange={(e) => {
                set('inheritAuth', e.target.checked ? undefined : false)
                chooseInheritance(e.target.checked)
              }}
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
            onChange={(e) => {
              set('authMethod', (e.target.value || undefined) as AuthMethod)
              chooseInheritance(e.target.value === '')
            }}
          >
            <option value="">Inherit ({effective.authMethod})</option>
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>

        {effective.authMethod === 'password' && (
          <label>
            Password {secretHint}
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
              Passphrase {secretHint}
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </label>
          </>
        )}

        {splitCredential && keyFrom && passphraseFrom && (
          <p className="settings-note warning-note">
            The key file comes from {levelName(keyFrom)} and the passphrase from{' '}
            {levelName(passphraseFrom)}. A passphrase saved for a different key will not open this
            one.
          </p>
        )}

        {effective.authMethod !== 'agent' && ownSecretNote}

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
            checked={effective.followTerminalCwd}
            onChange={(e) => set('followTerminalCwd', e.target.checked)}
          />
          SFTP panel follows the terminal&apos;s directory
        </label>
        <p className="settings-note">
          Keeps the SFTP panel on the directory the shell is in. Types one setup line into the
          shell on connect so it reports where it is; its echo is hidden. Off by default: it lets
          the host move the file browser. The ⇉ button in the panel switches it at any time.
        </p>

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
          On connect
          <textarea
            rows={2}
            value={profile.onConnectCommand ?? ''}
            placeholder={inheritNote('onConnectCommand') || 'e.g. sudo -i'}
            onChange={(e) => set('onConnectCommand', e.target.value)}
          />
        </label>
        <p className="settings-note">
          Typed into the shell as soon as it is ready, so you see it run and{' '}
          <code>cd</code> sticks. One command per line, run in order. It repeats on every
          reconnect.
        </p>

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

        <details className="settings-section">
          <summary>Appearance</summary>
          <p className="settings-note">
            Applies to this host's terminals only. Anything left on “inherit” follows the group,
            and then Settings — so marking one production box red changes nothing else.
          </p>
          <AppearanceFields
            value={profile}
            set={setLook}
            effective={appearance}
            inherited={inheritedLook}
            inheritedFrom={appearanceFrom}
            inheritToggle={
              profile.groupId ? { label: 'Inherit appearance from the group' } : undefined
            }
          />
        </details>

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
