import FileAccessFields from './FileAccessFields'
import { Fragment, useState } from 'react'
import { nanoid } from 'nanoid'
import type {
  AppearanceDefaults,
  AuthDefaults,
  PortForwardRule,
  RdpDefaults,
  SessionProfile
} from '../../../shared/types'
import { authFieldsState, secretToSave } from '../../../shared/authFields'
import { resolveAuth } from '../../../shared/authResolution'
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
import AppearanceFields from './AppearanceFields'
import AuthFields, { type AuthWords } from './AuthFields'
import RdpFields from './RdpFields'
import { useT } from '../i18n'
import PagedDialog, { type DialogPage } from './PagedDialog'
import ColourField from './ColourField'
import { SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import Hint from './Hint'
import AccountSelect from './AccountSelect'
import CollectionFields from './CollectionFields'
import { changedCollections, membershipsOf, type Membership } from '../state/membership'

/** The pages of the host dialog; only those the protocol has are shown. */
type HostPage = 'general' | 'login' | 'terminal' | 'files' | 'tunnels' | 'desktop'

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

export default function SessionDialog({
  initial,
  defaultGroupId = null,
  onClose
}: Props): JSX.Element {
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const credentials = useStore((s) => s.credentials)
  const settings = useStore((s) => s.settings)
  const upsertSession = useStore((s) => s.upsertSession)
  const collections = useStore((s) => s.collections)
  const upsertCollection = useStore((s) => s.upsertCollection)

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
  const [page, setPage] = useState<HostPage>('general')
  const [memberOf, setMemberOf] = useState<Record<string, Membership>>(() =>
    membershipsOf(collections, [profile.id])
  )
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
  // Resolved as the protocol this host speaks: an RDP host takes its group's
  // RDP port and login, an SSH host the SSH ones.
  const auth = authFieldsState({
    own: profile,
    parentId: profile.groupId,
    groups,
    forgetSecret,
    context: { protocol: protocolOf(profile), credentials }
  })
  /** An account chosen on the host itself stands in for the login fields. */
  const ownAccount = auth.account?.from === 'self'
  const effective = auth.effective
  const inheritNote = (key: keyof AuthDefaults): string => {
    const source = auth.inheritedFrom(key)
    return source ? t('inherited from {name}', { name: source.name }) : ''
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
    return source ? t('inherited from {name}', { name: source.name }) : ''
  }
  const ownGatewaySecret = isSet(profile.gatewaySecretRef)
  const ownSecret = auth.ownSecret

  const appearance = resolveAppearance(profile, profile.groupId, groups, settings)
  const inheritedLook = inheritedAppearance(profile, profile.groupId, groups, settings)
  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const source = appearanceSource(profile, profile.groupId, groups, key)
    return source ? t('the group {name}', { name: source.name }) : t('the settings')
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  function addForward(): void {
    const rule: PortForwardRule = {
      id: nanoid(),
      type: 'local',
      srcHost: '127.0.0.1',
      srcPort: 8080,
      dstHost: '127.0.0.1',
      dstPort: 80
    }
    set('portForwards', [...profile.portForwards, rule])
  }

  function updateForward(id: string, patch: Partial<PortForwardRule>): void {
    set(
      'portForwards',
      profile.portForwards.map((r) => (r.id === id ? { ...r, ...patch } : r))
    )
  }

  function removeForward(id: string): void {
    set(
      'portForwards',
      profile.portForwards.filter((r) => r.id !== id)
    )
  }

  async function submit(): Promise<void> {
    if (
      profile.fileAccess?.protocol === 'scp' &&
      (!profile.fileAccess.shell?.trim() || /[\r\n\0]/.test(profile.fileAccess.shell))
    ) {
      setError(t('Enter a single-line shell launch command.'))
      setPage('files')
      return
    }
    if (!profile.name.trim() || !profile.host.trim()) {
      setError(t('Name and host are required'))
      setPage('general')
      return
    }
    const tags = tagsInput
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
    const toSave: SessionProfile = { ...profile, tags, updatedAt: Date.now() }
    const secretToStore = secretToSave(auth.shownMethod, forgetSecret, secret)
    const gatewayToStore = gatewaySecret || (forgetGatewaySecret ? null : undefined)
    // A save the main process refuses — a full disk, a vault locked while the
    // dialog was open — is said here. It used to reject into nothing, and the
    // dialog simply stayed open with Save doing nothing.
    try {
      await upsertSession(toSave, secretToStore, gatewayToStore)
      for (const collection of changedCollections(collections, [profile.id], memberOf)) {
        await upsertCollection(collection)
      }
    } catch (err) {
      setError((err as Error).message)
      return
    }
    onClose()
  }

  const otherSessions = sessions.filter((s) => s.id !== profile.id)

  const secretHint =
    ownSecret && !forgetSecret
      ? t('(saved on this host — it overrides the group)')
      : inheritNote('secretRef')
        ? t('(blank keeps the one {source})', { source: inheritNote('secretRef') })
        : t('(leave blank to keep existing)')

  /**
   * Only a credential the host holds itself can be dropped here; an inherited one
   * belongs to the group that states it. Saying so matters: without it a wrong
   * group password looks like it was used when the host's own one was.
   */
  /**
   * Two whole sentences per case rather than one with a word slotted in.
   *
   * "This host has a {credential} of its own" reads correctly in English and
   * falls apart in a language where the noun changes the rest of the sentence.
   * It also hides the phrase from the coverage test, which reads the source for
   * `t('…')` and cannot see a string built at runtime — which is how these came
   * to be the only English left in a translated dialog.
   */
  const held =
    auth.shownMethod === 'privateKey'
      ? t(
          'This host has a passphrase of its own, and the nearest value wins: moving it into a group leaves the group’s unused.'
        )
      : t(
          'This host has a password of its own, and the nearest value wins: moving it into a group leaves the group’s unused.'
        )
  const inheritedSecret = inheritNote('secretRef')
  const forget =
    auth.shownMethod === 'privateKey'
      ? inheritedSecret
        ? t('On save this host forgets its own passphrase and uses the one {source}.', {
            source: inheritedSecret
          })
        : t(
            'On save this host forgets its own passphrase and uses whatever it is asked for on connect.'
          )
      : inheritedSecret
        ? t('On save this host forgets its own password and uses the one {source}.', {
            source: inheritedSecret
          })
        : t(
            'On save this host forgets its own password and uses whatever it is asked for on connect.'
          )

  const authWords: AuthWords = {
    inherit: t('Inherit'),
    secretHint,
    self: t('this host'),
    held,
    forget,
    keyPath: inheritNote('privateKeyPath') || t('No file selected')
  }

  /*
   * The pages this host has. A shell's — terminal, files, tunnels — are not
   * offered to a desktop, and a desktop's to a shell: a dialog that offers a
   * setting it cannot honour is a dialog that lies.
   */
  const inherits = Boolean(profile.groupId) && profile.inheritAuth !== false
  const pages: DialogPage<HostPage>[] = [
    { id: 'general', label: t('General'), icon: 'host' },
    {
      id: 'login',
      label: t('Sign-in'),
      icon: 'login',
      badge: inherits ? t('group') : undefined
    },
    ...(traits.textual
      ? [{ id: 'terminal' as const, label: t('Terminal'), icon: 'terminal' as const }]
      : []),
    ...(traits.files ? [{ id: 'files' as const, label: t('Files'), icon: 'files' as const }] : []),
    ...(traits.tunnels
      ? [
          {
            id: 'tunnels' as const,
            label: t('Tunnels'),
            icon: 'tunnels' as const,
            badge: profile.portForwards.length ? String(profile.portForwards.length) : undefined
          }
        ]
      : []),
    ...(isRdp ? [{ id: 'desktop' as const, label: t('Desktop'), icon: 'desktop' as const }] : [])
  ]
  // A page the protocol no longer has falls back to the first.
  const shown = pages.some((p) => p.id === page) ? page : 'general'
  const groupName = groups.find((g) => g.id === profile.groupId)?.name

  return (
    <PagedDialog
      title={initial ? profile.name || t('Edit session') : t('New session')}
      subtitle={[traits.label, groupName].filter(Boolean).join(' · ')}
      pages={pages}
      page={shown}
      onPage={setPage}
      error={error}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('Save')}
          </button>
        </>
      }
    >
      {shown === 'general' && (
        <>
          {/* Everything a new host needs is on this page, so one can be made
              without turning to any other. */}
          <SettingsGroup>
            <div className="settings-group-form">
              <label>
                {t('Name')}
                <input
                  autoFocus={!initial}
                  value={profile.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              </label>
              {/* Straight under the name, as a group's parent is: everything
                  else inherits from it. */}
              <label>
                {t('Group')}
                <select
                  value={profile.groupId ?? ''}
                  onChange={(e) => set('groupId', e.target.value || null)}
                >
                  <option value="">{t('(no group)')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {groupPath(g.id, groups)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('Connection')}>
            <div className="settings-group-form">
              <div className="form-row">
                <label style={{ flex: 1 }}>
                  {/* The mark only where it says something — for SSH the answer
                      is the whole rest of this dialog. */}
                  {protocolOf(profile) === 'ssh' ? (
                    t('Protocol')
                  ) : (
                    <Hint label={t('Protocol')}>
                      {t(
                        '{protocol} sessions open a desktop rather than a shell, so the file browser, port forwarding, monitoring and broadcast do not apply to them. How the desktop is reached and drawn is under Desktop below.',
                        { protocol: traitsOf(protocolOf(profile)).label }
                      )}
                    </Hint>
                  )}
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
                    // Resolved for this host's protocol, so an RDP host offers
                    // its group's RDP port, or 3389 — never the group's SSH port.
                    placeholder={String(effective.port)}
                    onChange={(e) =>
                      set('port', e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </label>
              </div>
            </div>
          </SettingsGroup>

          <CollectionFields collections={collections} value={memberOf} onChange={setMemberOf} />

          <SettingsGroup title={t('In the tree')}>
            <ColourField value={profile.color} onChange={(colour) => set('color', colour)} />
            <SettingRow
              label={t('Tags (comma separated)')}
              controlId="host-tags"
              note={t('The filter above the tree finds a host by its tags too.')}
            >
              <input
                id="host-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </SettingRow>
          </SettingsGroup>
        </>
      )}

      {shown === 'login' && (
        <>
          {profile.groupId && (
            <SettingsGroup>
              <SwitchRow
                label={t('Inherit connection settings from the group')}
                note={
                  groupName
                    ? t('Anything left blank on this page comes from “{name}”.', {
                        name: groupName
                      })
                    : undefined
                }
                checked={profile.inheritAuth !== false}
                onChange={(on) => {
                  set('inheritAuth', on ? undefined : false)
                  chooseInheritance(on)
                }}
              />
            </SettingsGroup>
          )}

          <SettingsGroup title={t('Who signs in')}>
            <div className="settings-group-form">
              <AccountSelect
                value={profile.credentialId}
                onChange={(id) => set('credentialId', id)}
                credentials={credentials}
                inherited={ownAccount ? undefined : auth.account}
              />

              <label>
                {t('Username')}
                <input
                  value={profile.username ?? ''}
                  disabled={ownAccount}
                  /*
                   * What this host will actually sign in as, when nothing is
                   * typed here: the group's login, or — when no group above it
                   * names one — the account this machine is logged in as,
                   * exactly as `ssh somehost` does.
                   */
                  placeholder={
                    auth.account
                      ? t('from the account {name}', { name: auth.account.credential.name })
                      : inheritNote('username') ||
                        t('{user}, the account on this machine', {
                          user: window.td.localUsername
                        })
                  }
                  onChange={(e) => set('username', e.target.value)}
                />
              </label>

              {!ownAccount && (
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
              )}
            </div>
            {traits.keyAuth && (
              <SwitchRow
                label={t('Forward SSH agent to remote host')}
                checked={effective.agentForward}
                onChange={(on) => set('agentForward', on)}
              />
            )}
          </SettingsGroup>

          {traits.jumpHost && (
            <SettingsGroup title={t('Jump host (ProxyJump)')}>
              <SettingRow
                label={t('Reach it through')}
                controlId="host-jump"
                note={t('Another saved host, as ssh -J does; nothing runs on it.')}
              >
                <select
                  id="host-jump"
                  value={profile.jumpHostId ?? ''}
                  onChange={(e) => set('jumpHostId', e.target.value || null)}
                >
                  <option value="">
                    {inheritNote('jumpHostId')
                      ? t('Inherit ({name})', {
                          name:
                            sessions.find((s) => s.id === effective.jumpHostId)?.name ?? t('None')
                        })
                      : t('None')}
                  </option>
                  {otherSessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </SettingsGroup>
          )}
        </>
      )}

      {shown === 'terminal' && (
        <>
          <SettingsGroup title={t('On connect')}>
            <div className="settings-group-form">
              <label>
                <Hint label={t('Commands')}>
                  {t('Typed into the shell as soon as it is ready, so you see it run and')}{' '}
                  <code>cd</code>{' '}
                  {t('sticks. One command per line, run in order. It repeats on every reconnect.')}
                </Hint>
                <textarea
                  rows={3}
                  value={profile.onConnectCommand ?? ''}
                  placeholder={inheritNote('onConnectCommand') || t('e.g. sudo -i')}
                  onChange={(e) => set('onConnectCommand', e.target.value)}
                />
              </label>
            </div>
            <SwitchRow
              label={t('Log session output to file')}
              checked={profile.logToFile}
              onChange={(on) => set('logToFile', on)}
            />
          </SettingsGroup>

          <SettingsGroup
            title={t('Appearance')}
            hint={t(
              'Applies to this host’s terminals only. Anything left on “inherit” follows the group, and then Settings — so marking one production box red changes nothing else.'
            )}
          >
            <div className="settings-group-form">
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
            </div>
          </SettingsGroup>
        </>
      )}

      {shown === 'files' && (
        <SettingsGroup title={t('File access')}>
          <div className="settings-group-form">
            <FileAccessFields
              value={profile.fileAccess}
              inherited={
                resolveAuth({ ...profile, fileAccess: undefined }, profile.groupId, groups, {
                  protocol: protocolOf(profile),
                  credentials
                }).fileAccess
              }
              canInherit={Boolean(profile.groupId) && profile.inheritAuth !== false}
              inheritedFrom={inheritNote('fileAccess')}
              onChange={(value) => set('fileAccess', value)}
            />
          </div>
          <SwitchRow
            label={t('SFTP panel follows the terminal’s directory')}
            hint={t(
              'Keeps the SFTP panel on the directory the shell is in. Types one setup line into the shell on connect so it reports where it is; its echo is hidden. Off by default: it lets the host move the file browser. The ⇉ button in the panel switches it at any time.'
            )}
            checked={effective.followTerminalCwd}
            onChange={(on) => set('followTerminalCwd', on)}
          />
        </SettingsGroup>
      )}

      {shown === 'tunnels' && (
        <SettingsGroup
          title={t('Port forwards')}
          hint={t(
            'Started by themselves every time this host connects. Tunnels in the pane toolbar starts and stops them, and adds one for that connection alone.'
          )}
        >
          {profile.portForwards.length === 0 ? (
            <p className="settings-note">{t('No port forwards yet.')}</p>
          ) : (
            <div className="pf-table">
              <span className="pf-head">{t('Type')}</span>
              <span className="pf-head">{t('From')}</span>
              <span className="pf-head">{t('To')}</span>
              <span />
              {profile.portForwards.map((r) => (
                <Fragment key={r.id}>
                  <select
                    value={r.type}
                    onChange={(e) =>
                      updateForward(r.id, { type: e.target.value as PortForwardRule['type'] })
                    }
                  >
                    <option value="local">{t('Local')}</option>
                    <option value="remote">{t('Remote')}</option>
                    <option value="dynamic">{t('Dynamic (SOCKS)')}</option>
                  </select>
                  <span className="pf-end">
                    <input
                      placeholder={t('src host')}
                      value={r.srcHost}
                      onChange={(e) => updateForward(r.id, { srcHost: e.target.value })}
                    />
                    <input
                      type="number"
                      placeholder={t('src port')}
                      value={r.srcPort}
                      onChange={(e) => updateForward(r.id, { srcPort: Number(e.target.value) })}
                    />
                  </span>
                  {r.type !== 'dynamic' ? (
                    <span className="pf-end">
                      <input
                        placeholder={t('dst host')}
                        value={r.dstHost ?? ''}
                        onChange={(e) => updateForward(r.id, { dstHost: e.target.value })}
                      />
                      <input
                        type="number"
                        placeholder={t('dst port')}
                        value={r.dstPort ?? 0}
                        onChange={(e) => updateForward(r.id, { dstPort: Number(e.target.value) })}
                      />
                    </span>
                  ) : (
                    <span className="settings-note">{t('wherever the client asks')}</span>
                  )}
                  <button
                    className="icon-button"
                    title={t('Remove')}
                    aria-label={t('Remove')}
                    onClick={() => removeForward(r.id)}
                  >
                    ✕
                  </button>
                </Fragment>
              ))}
            </div>
          )}
          <div className="settings-group-actions">
            <button onClick={addForward}>{t('+ Add')}</button>
          </div>
        </SettingsGroup>
      )}

      {shown === 'desktop' && (
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
      )}
    </PagedDialog>
  )
}
