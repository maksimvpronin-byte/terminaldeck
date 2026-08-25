import { useState } from 'react'
import { nanoid } from 'nanoid'
import type { AppearanceDefaults, AuthMethod, RdpDefaults, SessionGroup } from '../../../shared/types'
import { resolveAuth, inheritedFrom } from '../../../shared/authResolution'
import { isSet } from '../../../shared/overrides'
import {
  appearanceSource,
  inheritedAppearance,
  resolveAppearance
} from '../../../shared/appearance'
import { resolveRdp, rdpInheritedFrom } from '../../../shared/rdpResolution'
import { useStore } from '../state/store'
import AppearanceFields from './AppearanceFields'
import RdpFields from './RdpFields'
import ModalBackdrop from './ModalBackdrop'

interface Props {
  /** Existing group to edit, or the parent id for a new one. */
  initial?: SessionGroup
  parentId?: string | null
  onClose: () => void
}

export default function GroupDialog({ initial, parentId = null, onClose }: Props): JSX.Element {
  const groups = useStore((s) => s.groups)
  const settings = useStore((s) => s.settings)
  const upsertGroup = useStore((s) => s.upsertGroup)

  const [group, setGroup] = useState<SessionGroup>(
    initial ?? { id: nanoid(), name: '', parentId }
  )
  const [secret, setSecret] = useState('')
  const [forgetSecret, setForgetSecret] = useState(false)
  const [gatewaySecret, setGatewaySecret] = useState('')
  const [forgetGatewaySecret, setForgetGatewaySecret] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof SessionGroup>(key: K, value: SessionGroup[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  function setRdp<K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]): void {
    setGroup((g) => ({ ...g, [key]: value }))
  }

  /**
   * "Inherit" covers the credential as well: the group's own is dropped in the
   * same move, so it stops shadowing the parent's. Picking a method again keeps
   * it, and the note below says which way it stands.
   */
  function chooseInheritance(inherit: boolean): void {
    if (ownSecret) setForgetSecret(inherit)
  }

  // What this group would use if it defines nothing itself. A pending "forget"
  // counts, so the note can say what the group falls back to.
  const pending: SessionGroup = forgetSecret ? { ...group, secretRef: undefined } : group
  const effective = resolveAuth(pending, pending.parentId, groups)
  const from = (key: Parameters<typeof inheritedFrom>[3]): string => {
    const source = inheritedFrom(pending, pending.parentId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownSecret = isSet(group.secretRef)

  const desktop = resolveRdp(pending, pending.parentId, groups)
  const rdpNote = (key: keyof RdpDefaults): string => {
    const source = rdpInheritedFrom(pending, pending.parentId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownGatewaySecret = isSet(group.gatewaySecretRef)

  const appearance = resolveAppearance(group, group.parentId, groups, settings)
  const inheritedLook = inheritedAppearance(group, group.parentId, groups, settings)
  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const source = appearanceSource(group, group.parentId, groups, key)
    return source ? `the group ${source.name}` : 'Settings'
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  async function submit(): Promise<void> {
    if (!group.name.trim()) {
      setError('Name is required')
      return
    }
    // A password typed in now beats the "forget" tick — it is the later answer.
    await upsertGroup(
      group,
      secret || (forgetSecret ? null : undefined),
      gatewaySecret || (forgetGatewaySecret ? null : undefined)
    )
    onClose()
  }

  const secretHint =
    ownSecret && !forgetSecret
      ? '(saved on this group)'
      : from('secretRef')
        ? `(blank keeps the one ${from('secretRef')})`
        : '(leave blank to keep or inherit)'

  /** Lets a group hand the credential back to its parent, or drop a wrong one. */
  const ownSecretNote = ownSecret ? (
    <p className="settings-note">
      {forgetSecret
        ? `On save this group forgets its own, and uses ${
            from('secretRef') ? `the one ${from('secretRef')}` : 'whatever each host is asked for'
          }.`
        : 'Hosts inside use this unless they hold one of their own — a host that does keeps using it.'}{' '}
      <button type="button" onClick={() => setForgetSecret(!forgetSecret)}>
        {forgetSecret ? 'Keep it' : 'Forget it'}
      </button>
    </p>
  ) : null

  // A group cannot become its own descendant.
  const candidateParents = groups.filter((g) => {
    if (g.id === group.id) return false
    let cursor: string | null = g.parentId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (cursor === group.id) return false
      seen.add(cursor)
      cursor = groups.find((x) => x.id === cursor)?.parentId ?? null
    }
    return true
  })

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{initial ? 'Edit group' : 'New group'}</h2>
        <p className="settings-note">
          Anything left blank is inherited from the parent group. Sessions inside inherit whatever
          this group ends up with, so a shared login can be set once here.
        </p>

        <label>
          Name
          <input autoFocus value={group.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <label>
          Parent group
          <select
            value={group.parentId ?? ''}
            onChange={(e) => set('parentId', e.target.value || null)}
          >
            <option value="">(top level)</option>
            {candidateParents.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        {group.parentId && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={group.inheritAuth !== false}
              onChange={(e) => {
                set('inheritAuth', e.target.checked ? undefined : false)
                chooseInheritance(e.target.checked)
              }}
            />
            Inherit connection settings from the parent group
          </label>
        )}

        <div className="form-row">
          <label style={{ flex: 3 }}>
            Username
            <input
              value={group.username ?? ''}
              placeholder={from('username') || effective.username || 'not set'}
              onChange={(e) => set('username', e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              type="number"
              value={group.port ?? ''}
              placeholder={String(effective.port)}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        <label>
          Auth method
          <select
            value={group.authMethod ?? ''}
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

        {(group.authMethod ?? effective.authMethod) === 'password' && (
          <label>
            Password {secretHint}
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        )}

        {(group.authMethod ?? effective.authMethod) === 'privateKey' && (
          <>
            <div className="form-row">
              <label style={{ flex: 1 }}>
                Private key file
                <input
                  readOnly
                  value={group.privateKeyPath ?? ''}
                  placeholder={from('privateKeyPath') || 'not set'}
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

        {(group.authMethod ?? effective.authMethod) !== 'agent' && ownSecretNote}

        <label>
          On connect
          <textarea
            rows={2}
            value={group.onConnectCommand ?? ''}
            placeholder={from('onConnectCommand') || 'e.g. sudo -i'}
            onChange={(e) => set('onConnectCommand', e.target.value)}
          />
        </label>
        <p className="settings-note">
          Run in the shell of every host in this group, one command per line.
        </p>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={effective.followTerminalCwd}
            onChange={(e) => set('followTerminalCwd', e.target.checked)}
          />
          SFTP panel follows the terminal&apos;s directory
        </label>

        <details className="settings-section">
          <summary>Appearance</summary>
          <p className="settings-note">
            Everything in this group inherits what you set here, so a whole environment can be
            given its own colours in one place.
          </p>
          <AppearanceFields
            value={group}
            set={setLook}
            effective={appearance}
            inherited={inheritedLook}
            inheritedFrom={appearanceFrom}
            inheritToggle={
              group.parentId ? { label: 'Inherit appearance from the parent group' } : undefined
            }
          />
        </details>

        <details className="settings-section">
          <summary>Desktop</summary>
          <p className="settings-note">
            Applies to the RDP hosts in this group. A gateway stated here reaches every one of
            them, which is the point of putting it on a group rather than on each machine.
          </p>
          <RdpFields
            value={group}
            set={setRdp}
            effective={desktop}
            inheritedFrom={rdpNote}
            inheritToggle={
              group.parentId ? { label: 'Inherit desktop settings from the parent group' } : undefined
            }
            secret={{
              typed: gatewaySecret,
              onTyped: setGatewaySecret,
              own: ownGatewaySecret,
              forget: forgetGatewaySecret,
              onForget: setForgetGatewaySecret
            }}
          />
        </details>

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit} disabled={!group.name.trim()}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
