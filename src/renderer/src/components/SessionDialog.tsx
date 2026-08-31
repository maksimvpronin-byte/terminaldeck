import { useState } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppearanceDefaults,
  AuthDefaults,
  PortForwardRule,
  RdpDefaults,
  SessionProfile
} from '../../../shared/types'
import { authFieldsState, secretToSave } from '../../../shared/authFields'
import { isSet } from '../../../shared/overrides'
import {
  appearanceSource,
  inheritedAppearance,
  resolveAppearance
} from '../../../shared/appearance'
import { groupPath } from '../../../shared/groups'
import { PROTOCOLS, protocolOf, traitsOf, type Protocol } from '../../../shared/protocols'
import { resolveRdp, rdpInheritedFrom } from '../../../shared/rdpResolution'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
import AuthFields, { type AuthWords } from './AuthFields'
import RdpFields from './RdpFields'
import { useT } from '../i18n'
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
  /** Typed for the gateway, when it wants a login other than the host's. */
  const [gatewaySecret, setGatewaySecret] = useState('')
  const [forgetGatewaySecret, setForgetGatewaySecret] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()

  function set<K extends keyof SessionProfile>(key: K, value: SessionProfile[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  function setRdp<K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  /**
   * Handing the credential settings back to the group hands the host's own
   * password back with it — leaving it behind is what makes a group password
   * look ignored. The method dropdown does the same thing from inside
   * AuthFields; this is the tickbox above it.
   */
  function chooseInheritance(inherit: boolean): void {
    if (auth.ownSecret) setForgetSecret(inherit)
  }

  function setAuth<K extends keyof AuthDefaults>(key: K, value: AuthDefaults[K]): void {
    setProfile((p) => ({ ...p, [key]: value }))
  }

  // What this session ends up with once inheritance is applied. Pending changes
  // count, so ticking "forget" immediately shows what it would inherit instead.
  const pending: SessionProfile = forgetSecret ? { ...profile, secretRef: undefined } : profile
  const auth = authFieldsState({ own: profile, parentId: profile.groupId, groups, forgetSecret })
  const effective = auth.effective
  const inheritNote = (key: keyof AuthDefaults): string => {
    const source = auth.inheritedFrom(key)
    return source ? `inherited from ${source.name}` : ''
  }

  const desktop = resolveRdp(pending, pending.groupId, groups)
  const isRdp = protocolOf(profile) === 'rdp'
  /**
   * What this host can actually use. A shell's settings — a key file, a jump
   * host, a command typed on connect, a terminal font, a tunnel — are not
   * merely unused on a desktop, they cannot be honoured, and a dialog that
   * offers them is a dialog that lies.
   */
  const traits = traitsOf(protocolOf(profile))
  const rdpNote = (key: keyof RdpDefaults): string => {
    const source = rdpInheritedFrom(pending, pending.groupId, groups, key)
    return source ? `inherited from ${source.name}` : ''
  }
  const ownGatewaySecret = isSet(profile.gatewaySecretRef)
  const ownSecret = auth.ownSecret

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
      setError(t('Name and host are required'))
      return
    }
    if (!effective.username.trim()) {
      setError(t('Username is not set here and none is inherited from a group'))
      return
    }
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
    const toSave: SessionProfile = { ...profile, tags, updatedAt: Date.now() }
    const secretToStore = secretToSave(auth.shownMethod, forgetSecret, secret)
    const gatewayToStore = gatewaySecret || (forgetGatewaySecret ? null : undefined)
    await upsertSession(toSave, secretToStore, gatewayToStore)
    onClose()
  }

  const otherSessions = sessions.filter((s) => s.id !== profile.id)

  const secretHint =
    ownSecret && !forgetSecret
      ? t('(saved on this host — it overrides the group)')
      : inheritNote('secretRef')
        ? `(blank keeps the one ${inheritNote('secretRef')})`
        : t('(leave blank to keep existing)')

  /**
   * Only a credential the host holds itself can be dropped here; an inherited one
   * belongs to the group that states it. Saying so matters: without it a wrong
   * group password looks like it was used when the host's own one was.
   */
  const credential = auth.shownMethod === 'privateKey' ? 'passphrase' : 'password'
  const authWords: AuthWords = {
    inherit: t('Inherit'),
    secretHint,
    self: 'this host',
    held: `This host has a ${credential} of its own, and the nearest value wins: moving it into a group leaves the group's unused.`,
    forget: `On save this host forgets its own ${credential} and uses ${
      inheritNote('secretRef')
        ? `the one ${inheritNote('secretRef')}`
        : 'whatever it is asked for on connect'
    }.`,
    keyPath: inheritNote('privateKeyPath') || 'No file selected'
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? t('Edit session') : t('New session')}</h2>

        <label>
          {t('Name')}
          <input value={profile.name} onChange={(e) => set('name', e.target.value)} />
        </label>

        <div className="form-row">
          <label style={{ flex: 1 }}>
            {t('Protocol')}
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
            {t('Host')}
            <input value={profile.host} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            {t('Port')}
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
          <p className="settings-note">
            {traitsOf(protocolOf(profile)).label} sessions open a desktop rather than a shell, so
            the file browser, port forwarding, monitoring and broadcast do not apply to them. How
            the desktop is reached and drawn is under <em>Desktop</em> below.
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
            {t('Inherit connection settings from the group')}
          </label>
        )}

        <label>
          {t('Username')}
          <input
            value={profile.username ?? ''}
            placeholder={inheritNote('username') || 'required'}
            onChange={(e) => set('username', e.target.value)}
          />
        </label>

        <AuthFields
          value={profile}
          set={setAuth}
          state={auth}
          secret={secret}
          onSecret={setSecret}
          forgetSecret={forgetSecret}
          onForgetSecret={setForgetSecret}
          onPickKey={pickKey}
          methods={traits.keyAuth ? undefined : ['password']}
          words={authWords}
        />

        {traits.keyAuth && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={effective.agentForward}
              onChange={(e) => set('agentForward', e.target.checked)}
            />
            {t('Forward SSH agent to remote host')}
          </label>
        )}

        {traits.files && (
          <>
            <label className="checkbox-row" style={{ flexDirection: 'row' }}>
              <input
                type="checkbox"
                checked={effective.followTerminalCwd}
                onChange={(e) => set('followTerminalCwd', e.target.checked)}
              />
              {t('SFTP panel follows the terminal’s directory')}
            </label>
            <p className="settings-note">
              {t(
                'Keeps the SFTP panel on the directory the shell is in. Types one setup line into the shell on connect so it reports where it is; its echo is hidden. Off by default: it lets the host move the file browser. The ⇉ button in the panel switches it at any time.'
              )}
            </p>
          </>
        )}

        {traits.textual && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={profile.logToFile}
              onChange={(e) => set('logToFile', e.target.checked)}
            />
            {t('Log session output to file')}
          </label>
        )}

        {traits.jumpHost && (
          <label>
            {t('Jump host (ProxyJump)')}
            <select
              value={profile.jumpHostId ?? ''}
              onChange={(e) => set('jumpHostId', e.target.value || null)}
            >
              <option value="">
                {inheritNote('jumpHostId')
                  ? `Inherited (${sessions.find((s) => s.id === effective.jumpHostId)?.name ?? 'none'})`
                  : t('None')}
              </option>
              {otherSessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {traits.textual && (
          <>
            <label>
              {t('On connect')}
              <textarea
                rows={2}
                value={profile.onConnectCommand ?? ''}
                placeholder={inheritNote('onConnectCommand') || t('e.g. sudo -i')}
                onChange={(e) => set('onConnectCommand', e.target.value)}
              />
            </label>
            <p className="settings-note">
              {t('Typed into the shell as soon as it is ready, so you see it run and')}{' '}
              <code>cd</code>{' '}
              {t('sticks. One command per line, run in order. It repeats on every reconnect.')}
            </p>
          </>
        )}

        <label>
          {t('Group')}
          <select value={profile.groupId ?? ''} onChange={(e) => set('groupId', e.target.value || null)}>
            <option value="">{t('(no group)')}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(g.id, groups)}
              </option>
            ))}
          </select>
        </label>

        <label>
          {t('Colour')}
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!profile.color ? 'selected' : ''}`}
              title={t('No colour')}
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
          {t('Tags (comma separated)')}
          <input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} />
        </label>

        {traits.textual && (
          <details className="settings-section">
            <summary>{t('Appearance')}</summary>
            <p className="settings-note">
              {t(
                'Applies to this host’s terminals only. Anything left on “inherit” follows the group, and then Settings — so marking one production box red changes nothing else.'
              )}
            </p>
            <AppearanceFields
              value={profile}
              set={setLook}
              effective={appearance}
              inherited={inheritedLook}
              inheritedFrom={appearanceFrom}
              inheritToggle={
                profile.groupId ? { label: t('Inherit appearance from the group') } : undefined
              }
            />
          </details>
        )}

        {isRdp && (
          <details className="settings-section" open>
            <summary>{t('Desktop')}</summary>
            <RdpFields
              value={profile}
              set={setRdp}
              effective={desktop}
              inheritedFrom={rdpNote}
              inheritToggle={
                profile.groupId ? { label: t('Inherit desktop settings from the group') } : undefined
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
        )}

        {/* A desktop has no tunnels: the far end is reached, not proxied. */}
        {traits.tunnels && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('Port forwards')}</span>
              <button onClick={addForward}>{t('+ Add')}</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
              {profile.portForwards.map((r) => (
                <div className="pf-rule" key={r.id}>
                  <select value={r.type} onChange={(e) => updateForward(r.id, { type: e.target.value as PortForwardRule['type'] })}>
                    <option value="local">{t('Local')}</option>
                    <option value="remote">{t('Remote')}</option>
                    <option value="dynamic">{t('Dynamic (SOCKS)')}</option>
                  </select>
                  <input
                    placeholder={t('src host')}
                    value={r.srcHost}
                    onChange={(e) => updateForward(r.id, { srcHost: e.target.value })}
                    style={{ width: 90 }}
                  />
                  <input
                    type="number"
                    placeholder={t('src port')}
                    value={r.srcPort}
                    onChange={(e) => updateForward(r.id, { srcPort: Number(e.target.value) })}
                    style={{ width: 70 }}
                  />
                  {r.type !== 'dynamic' && (
                    <>
                      <span>→</span>
                      <input
                        placeholder={t('dst host')}
                        value={r.dstHost ?? ''}
                        onChange={(e) => updateForward(r.id, { dstHost: e.target.value })}
                        style={{ width: 90 }}
                      />
                      <input
                        type="number"
                        placeholder={t('dst port')}
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
        )}

        {error && <span className="error-text">{error}</span>}

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('Save')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
