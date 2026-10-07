import FileAccessFields from './FileAccessFields'
import { useState } from 'react'
import type {
  AppearanceDefaults,
  AuthDefaults,
  InventoryOverride,
  RdpDefaults,
  SessionGroup,
  SessionProfile
} from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { authFieldsState, secretToSave } from '../../../shared/authFields'
import { applyOverride, isSet } from '../../../shared/overrides'
import { appearanceSource, resolveAppearance } from '../../../shared/appearance'
import { resolveRdp } from '../../../shared/rdpResolution'
import { asProtocol, PROTOCOLS, protocolOf, traitsOf } from '../../../shared/protocols'
import { useStore } from '../state/store'
import AppearanceFields from './AppearanceFields'
import AuthFields, { type AuthWords } from './AuthFields'
import RdpFields from './RdpFields'
import PagedDialog, { type DialogPage } from './PagedDialog'
import ColourField from './ColourField'
import { SettingRow, SettingsGroup, SwitchRow } from './SettingsGroup'
import { useT } from '../i18n'
import AccountSelect from './AccountSelect'
import CollectionFields from './CollectionFields'
import {
  changedCollections,
  hostsInTreeGroup,
  membershipsOf,
  type Membership
} from '../state/membership'

interface Props {
  /** The host or Ansible group the local settings apply to. */
  node: SessionProfile | SessionGroup
  /** Every inventory group, for working out what the node inherits. */
  groups: SessionGroup[]
  /**
   * Which store the settings belong to: an Inventory source's, or a Sessions
   * folder mirroring a repository. The question the dialog asks is the same
   * either way; only where the answer is kept differs.
   */
  scope?: 'inventory' | 'gitFolder'
  onClose: () => void
}

function isHost(node: SessionProfile | SessionGroup): node is SessionProfile {
  return 'host' in node
}

/** The pages of a repository node's local settings. */
type OverridePage = 'general' | 'login' | 'terminal' | 'files' | 'desktop'

export default function InventoryOverrideDialog({
  node,
  groups,
  scope = 'inventory',
  onClose
}: Props): JSX.Element {
  const fromGit = scope === 'gitFolder'
  const existing = useStore((s) =>
    (fromGit ? s.gitFolderOverrides : s.inventoryOverrides).find((o) => o.nodeId === node.id)
  )
  const saveOverride = useStore((s) =>
    fromGit ? s.saveGitFolderOverride : s.saveInventoryOverride
  )
  const clearOverride = useStore((s) =>
    fromGit ? s.clearGitFolderOverride : s.clearInventoryOverride
  )
  const sessions = useStore((s) => s.sessions)
  const credentials = useStore((s) => s.credentials)
  const settings = useStore((s) => s.settings)
  const collections = useStore((s) => s.collections)
  const upsertCollection = useStore((s) => s.upsertCollection)
  const trees = useStore((s) => (fromGit ? s.gitFolderTrees : s.inventoryTrees))
  const t = useT()
  /**
   * The hosts the collections below are ticked for: this one, or every host in
   * this group. Taken once, when the dialog opens, as the other dialogs do — a
   * sync finishing meanwhile must not change what the ticks were shown against.
   */
  const [hostIds] = useState<string[]>(() =>
    isHost(node) ? [node.id] : hostsInTreeGroup(trees, node.id)
  )
  const [memberOf, setMemberOf] = useState<Record<string, Membership>>(() =>
    membershipsOf(collections, hostIds)
  )

  const [override, setOverride] = useState<InventoryOverride>(existing ?? { nodeId: node.id })
  const [error, setError] = useState<string>()
  const [page, setPage] = useState<OverridePage>('general')
  const [secret, setSecret] = useState('')
  // A credential kept here wins over anything the inventory says, so dropping it
  // has to be possible without throwing the rest of the override away.
  const [forgetSecret, setForgetSecret] = useState(false)
  const [gatewaySecret, setGatewaySecret] = useState('')
  const [forgetGatewaySecret, setForgetGatewaySecret] = useState(false)

  function set<K extends keyof InventoryOverride>(key: K, value: InventoryOverride[K]): void {
    setOverride((o) => ({ ...o, [key]: value }))
  }

  function setLook<K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]): void {
    setOverride((o) => ({ ...o, [key]: value }))
  }

  function setRdp<K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]): void {
    setOverride((o) => ({ ...o, [key]: value }))
  }

  function setAuth<K extends keyof AuthDefaults>(key: K, value: AuthDefaults[K]): void {
    setOverride((o) => ({ ...o, [key]: value }))
  }

  // A group inherits from its parent; a host from the group it sits in.
  const parentId = isHost(node) ? node.groupId : node.parentId
  /**
   * What this node can use. A group is not asked and gets everything: an
   * inventory group holds Linux and Windows hosts alike, and protocol is not
   * inherited. Only a host knows what it speaks.
   *
   * The override is read first, so ticking RDP on a host the repository calls
   * nothing in particular reveals the Desktop section and hides the settings a
   * desktop has no use for, without saving and reopening.
   */
  const protocol = isHost(node) ? (override.protocol ?? protocolOf(node)) : 'ssh'
  const traits = traitsOf(protocol)
  // What the repository alone would give this node, ignoring the override.
  const fromRepo = resolveAuth(node, parentId, groups, { protocol, credentials })

  /**
   * The override, then what the repository and its groups say, then the
   * application-wide settings — one merge, used for the connection settings and
   * the appearance alike.
   *
   * Through `applyOverride`, which is also how the main process layers it when
   * it connects. The connection settings used a plain spread until now, which
   * wrote a cleared field's `undefined` over the repository's value instead of
   * falling back to it: a field set back to "from the inventory" showed the
   * group's setting for a connection that would use the repository's.
   */
  const merged = applyOverride(node, override)
  // The same layering, through the shared rules the other two dialogs use: the
  // override on top, the inventory host beneath it, then the groups.
  const auth = authFieldsState({
    own: override,
    beneath: node,
    parentId,
    groups,
    forgetSecret,
    context: { protocol, credentials }
  })
  /** An account chosen here stands in for the login fields. */
  const ownAccount = auth.account?.from === 'self'
  const effective = auth.effective
  const appearance = resolveAppearance(merged, parentId, groups, settings)
  const inheritedLook = resolveAppearance(
    { ...node, inheritAppearance: merged.inheritAppearance },
    parentId,
    groups,
    settings
  )
  const desktop = resolveRdp(merged, parentId, groups)
  /**
   * A repository can name a gateway, and an override can replace it. Which of
   * the two is speaking has to be visible, or a host that ignores the gateway
   * typed here looks broken rather than overridden.
   */
  const rdpFrom = (key: keyof RdpDefaults): string => {
    const own: RdpDefaults = node
    return isSet(own[key]) ? t('from the inventory') : ''
  }

  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const own: AppearanceDefaults = node
    if (isSet(own[key])) return t('the inventory')
    const source = appearanceSource(node, parentId, groups, key)
    return source ? t('the group {name}', { name: source.name }) : t('the settings')
  }

  async function pickKey(): Promise<void> {
    const path = await window.td.dialogs.pickPrivateKey()
    if (path) set('privateKeyPath', path)
  }

  /**
   * A credential here is local to this one host: the inventory is read-only and
   * never carries one, so there is nothing above to hand it back to except the
   * groups.
   */
  const authWords: AuthWords = {
    inherit: t('From the inventory'),
    secretHint:
      auth.ownSecret && !forgetSecret
        ? t('(saved here, and it overrides the inventory)')
        : t('(leave blank to keep the current one)'),
    self: t('this host'),
    held: t(
      'This password is kept locally for this host alone, so nothing set on a group above it is used.'
    ),
    forget: t('On save this password is forgotten, and the host is asked for one on connect.'),
    keyPath: fromRepo.privateKeyPath ?? t('No file selected')
  }

  async function submit(): Promise<void> {
    if (
      override.fileAccess?.protocol === 'scp' &&
      (!override.fileAccess.shell?.trim() || /[\r\n\0]/.test(override.fileAccess.shell))
    ) {
      setError(t('Enter a single-line shell launch command.'))
      setPage('files')
      return
    }
    const toSave: InventoryOverride = forgetSecret
      ? { ...override, secretRef: undefined }
      : override
    const hasContent =
      secret !== '' ||
      Object.entries(toSave).some(
        ([key, value]) => key !== 'nodeId' && value !== undefined && value !== null && value !== ''
      )
    // An override with nothing in it would still mark the host as customised.
    // Clearing it drops the credential too, so forgetting one is not lost here.
    // Said here when refused, rather than leaving Save doing nothing.
    try {
      if (!hasContent) {
        if (existing) await clearOverride(node.id)
      } else {
        await saveOverride(
          toSave,
          secretToSave(auth.shownMethod, forgetSecret, secret),
          gatewaySecret || (forgetGatewaySecret ? null : undefined)
        )
      }
      // Kept in the collections, not in the override: being in a set is not
      // a connection setting, and resetting the override leaves it alone.
      for (const collection of changedCollections(collections, hostIds, memberOf)) {
        await upsertCollection(collection)
      }
    } catch (err) {
      setError((err as Error).message)
      return
    }
    onClose()
  }

  async function reset(): Promise<void> {
    try {
      await clearOverride(node.id)
    } catch (err) {
      setError((err as Error).message)
      return
    }
    onClose()
  }

  const showsDesktop = isHost(node) && protocol === 'rdp'
  const pages: DialogPage<OverridePage>[] = [
    { id: 'general', label: t('General'), icon: 'host' },
    { id: 'login', label: t('Sign-in'), icon: 'login' },
    ...(traits.textual
      ? [{ id: 'terminal' as const, label: t('Terminal'), icon: 'terminal' as const }]
      : []),
    ...(traits.files ? [{ id: 'files' as const, label: t('Files'), icon: 'files' as const }] : []),
    ...(showsDesktop
      ? [{ id: 'desktop' as const, label: t('Desktop'), icon: 'desktop' as const }]
      : [])
  ]
  // A page the protocol no longer has falls back to the first.
  const shown = pages.some((p) => p.id === page) ? page : 'general'

  return (
    <PagedDialog
      title={node.name}
      subtitle={isHost(node) ? t('Local settings') : t('Local settings for the group')}
      pages={pages}
      page={shown}
      onPage={setPage}
      error={error}
      onClose={onClose}
      actions={
        <>
          {existing && (
            <button className="danger" onClick={reset} style={{ marginRight: 'auto' }}>
              {t('Remove override')}
            </button>
          )}
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('Save')}
          </button>
        </>
      }
    >
      {shown === 'general' && (
        <>
          <p className="settings-note">
            {t(
              'Kept outside the repository and re-applied after every sync, so pulling never discards them. Leave a field blank to keep what the inventory says.'
            )}
            {!isHost(node) && ` ${t('Everything in this group inherits what you set here.')}`}
          </p>

          {isHost(node) && (
            <SettingsGroup title={t('Connection')}>
              <div className="settings-group-form">
                <label>
                  {t('Protocol')}
                  <select
                    value={override.protocol ?? ''}
                    onChange={(e) => set('protocol', asProtocol(e.target.value))}
                  >
                    <option value="">
                      {t('From the inventory ({protocol})', {
                        protocol: traitsOf(protocolOf(node)).label
                      })}
                    </option>
                    {PROTOCOLS.map((name) => (
                      <option key={name} value={name}>
                        {traitsOf(name).label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="settings-note">
                  {t('Connects as')} <strong>{effective.username || t('(no user)')}</strong>@
                  {node.host}:{effective.port} {t('using')} {effective.authMethod}
                  {effective.jumpHostId
                    ? ` ${t('via {name}', {
                        name:
                          sessions.find((s) => s.id === effective.jumpHostId)?.name ??
                          t('a jump host')
                      })}`
                    : ''}
                  .
                </p>
              </div>
            </SettingsGroup>
          )}

          {hostIds.length > 0 && (
            <CollectionFields
              collections={collections}
              value={memberOf}
              onChange={setMemberOf}
              forGroup={!isHost(node)}
            />
          )}

          <SettingsGroup title={t('In the tree')}>
            <ColourField
              value={override.color}
              onChange={(colour) => set('color', colour)}
              noneTitle={t('Use the repository’s colour')}
            />
          </SettingsGroup>
        </>
      )}

      {shown === 'login' && (
        <>
          <SettingsGroup title={t('Who signs in')}>
            <div className="settings-group-form">
              <div className="form-row">
                <label style={{ flex: 3 }}>
                  {t('Username')}
                  <input
                    autoFocus
                    value={override.username ?? ''}
                    disabled={ownAccount}
                    placeholder={
                      auth.account
                        ? t('from the account {name}', { name: auth.account.credential.name })
                        : fromRepo.username || t('not set in the inventory')
                    }
                    onChange={(e) => set('username', e.target.value)}
                  />
                </label>
                <label style={{ flex: 1 }}>
                  {t('Port')}
                  <input
                    type="number"
                    value={override.port ?? ''}
                    /* Resolved for the protocol: a desktop takes its groups' RDP
                       port, or 3389 — never an SSH port. */
                    placeholder={String(fromRepo.port)}
                    onChange={(e) =>
                      set('port', e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </label>
              </div>

              <AccountSelect
                value={override.credentialId}
                onChange={(id) => set('credentialId', id)}
                credentials={credentials}
                inherited={ownAccount ? undefined : auth.account}
              />

              {!ownAccount && (
                <AuthFields
                  value={override}
                  set={setAuth}
                  state={auth}
                  secret={secret}
                  onSecret={setSecret}
                  forgetSecret={forgetSecret}
                  onForgetSecret={setForgetSecret}
                  onPickKey={pickKey}
                  words={authWords}
                />
              )}
            </div>
            {traits.keyAuth && (
              <SwitchRow
                label={t('Forward SSH agent to remote host')}
                checked={override.agentForward ?? fromRepo.agentForward}
                onChange={(on) => set('agentForward', on)}
              />
            )}
          </SettingsGroup>

          {traits.jumpHost && (
            <SettingsGroup title={t('Jump host (ProxyJump)')}>
              <SettingRow label={t('Reach it through')} controlId="override-jump">
                <select
                  id="override-jump"
                  value={override.jumpHostId ?? ''}
                  onChange={(e) => set('jumpHostId', e.target.value || undefined)}
                >
                  <option value="">
                    {fromRepo.jumpHostId
                      ? t('From above ({name})', {
                          name:
                            sessions.find((s) => s.id === fromRepo.jumpHostId)?.name ?? t('unknown')
                        })
                      : t('None')}
                  </option>
                  {/* Only saved sessions can act as a bastion: an inventory host
                      is rebuilt on every sync and its id would not survive a
                      rename. */}
                  {sessions.map((s) => (
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
                {t('Commands')}
                <textarea
                  rows={3}
                  value={override.onConnectCommand ?? ''}
                  placeholder={t('e.g. sudo -i')}
                  onChange={(e) => set('onConnectCommand', e.target.value)}
                />
              </label>
              <p className="settings-note">
                {t(
                  'Set here and nowhere else: this is never read from the repository. It is arbitrary code run on every connection, and honouring it from a repo would hand command execution to anyone able to commit there.'
                )}
              </p>
            </div>
          </SettingsGroup>

          <SettingsGroup
            title={t('Appearance')}
            hint={
              <>
                {t('Kept locally like everything else here, so a sync never takes it away.')}
                {!isHost(node) && ` ${t('Hosts in this group inherit it.')}`}
              </>
            }
          >
            <div className="settings-group-form">
              <AppearanceFields
                value={override}
                set={setLook}
                effective={appearance}
                inherited={inheritedLook}
                inheritedFrom={appearanceFrom}
                inheritToggle={{ label: t('Inherit appearance from the inventory groups') }}
              />
            </div>
          </SettingsGroup>
        </>
      )}

      {shown === 'files' && (
        <SettingsGroup title={t('File access')}>
          <div className="settings-group-form">
            <FileAccessFields
              value={override.fileAccess}
              inherited={fromRepo.fileAccess}
              canInherit
              onChange={(value) => set('fileAccess', value)}
            />
          </div>
          <SwitchRow
            label={t('SFTP panel follows the terminal’s directory')}
            checked={override.followTerminalCwd ?? fromRepo.followTerminalCwd}
            onChange={(on) => set('followTerminalCwd', on)}
          />
        </SettingsGroup>
      )}

      {shown === 'desktop' && (
        <>
          <p className="settings-note">
            {t(
              'Kept locally, so a sync never takes it away — including a gateway the repository does not know about.'
            )}
          </p>
          <RdpFields
            value={override}
            set={setRdp}
            effective={desktop}
            inheritedFrom={rdpFrom}
            inheritToggle={{ label: t('Inherit desktop settings from the inventory groups') }}
            secret={{
              typed: gatewaySecret,
              onTyped: setGatewaySecret,
              own: isSet(override.gatewaySecretRef),
              forget: forgetGatewaySecret,
              onForget: setForgetGatewaySecret
            }}
          />
        </>
      )}
    </PagedDialog>
  )
}
