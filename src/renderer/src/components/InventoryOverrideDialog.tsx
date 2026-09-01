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
import { protocolOf, traitsOf } from '../../../shared/protocols'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
import AuthFields, { type AuthWords } from './AuthFields'
import RdpFields from './RdpFields'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'
import Hint from './Hint'

interface Props {
  /** The host or Ansible group the local settings apply to. */
  node: SessionProfile | SessionGroup
  /** Every inventory group, for working out what the node inherits. */
  groups: SessionGroup[]
  onClose: () => void
}

function isHost(node: SessionProfile | SessionGroup): node is SessionProfile {
  return 'host' in node
}

export default function InventoryOverrideDialog({ node, groups, onClose }: Props): JSX.Element {
  const existing = useStore((s) => s.inventoryOverrides.find((o) => o.nodeId === node.id))
  const saveInventoryOverride = useStore((s) => s.saveInventoryOverride)
  const clearInventoryOverride = useStore((s) => s.clearInventoryOverride)
  const sessions = useStore((s) => s.sessions)
  const settings = useStore((s) => s.settings)
  const t = useT()

  const [override, setOverride] = useState<InventoryOverride>(existing ?? { nodeId: node.id })
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
   */
  const traits = isHost(node) ? traitsOf(protocolOf(node)) : traitsOf('ssh')
  // What the repository alone would give this node, ignoring the override.
  const fromRepo = resolveAuth(node, parentId, groups)

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
  const auth = authFieldsState({ own: override, beneath: node, parentId, groups, forgetSecret })
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
    return isSet(own[key]) ? 'from the inventory' : ''
  }

  const appearanceFrom = (key: keyof AppearanceDefaults): string => {
    const own: AppearanceDefaults = node
    if (isSet(own[key])) return 'the inventory'
    const source = appearanceSource(node, parentId, groups, key)
    return source ? `the group ${source.name}` : 'Settings'
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
    secretHint: auth.ownSecret && !forgetSecret
      ? '(saved here, and it overrides the inventory)'
      : '(leave blank to keep the current one)',
    self: 'this host',
    held: 'This password is kept locally for this host alone, so nothing set on a group above it is used.',
    forget: 'On save this password is forgotten, and the host is asked for one on connect.',
    keyPath: fromRepo.privateKeyPath ?? 'No file selected'
  }

  async function submit(): Promise<void> {
    const toSave: InventoryOverride = forgetSecret ? { ...override, secretRef: undefined } : override
    const hasContent =
      secret !== '' ||
      Object.entries(toSave).some(
        ([key, value]) => key !== 'nodeId' && value !== undefined && value !== null && value !== ''
      )
    // An override with nothing in it would still mark the host as customised.
    // Clearing it drops the credential too, so forgetting one is not lost here.
    if (!hasContent) {
      if (existing) await clearInventoryOverride(node.id)
      onClose()
      return
    }
    await saveInventoryOverride(
      toSave,
      secretToSave(auth.shownMethod, forgetSecret, secret),
      gatewaySecret || (forgetGatewaySecret ? null : undefined)
    )
    onClose()
  }

  async function reset(): Promise<void> {
    await clearInventoryOverride(node.id)
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>
          {isHost(node)
            ? t('Local settings for {name}', { name: node.name })
            : t('Local settings for group {name}', { name: node.name })}
        </h2>
        <p className="settings-note">
          {t(
            'Kept outside the repository and re-applied after every sync, so pulling never discards them. Leave a field blank to keep what the inventory says.'
          )}
          {!isHost(node) && ` ${t('Everything in this group inherits what you set here.')}`}
        </p>

        <div className="form-row">
          <label style={{ flex: 3 }}>
            {t('Username')}
            <input
              autoFocus
              value={override.username ?? ''}
              placeholder={fromRepo.username || t('not set in the inventory')}
              onChange={(e) => set('username', e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            {t('Port')}
            <input
              type="number"
              value={override.port ?? ''}
              placeholder={String(fromRepo.port)}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

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

        {traits.jumpHost && (
          <label>
            {t('Jump host (ProxyJump)')}
            <select
              value={override.jumpHostId ?? ''}
              onChange={(e) => set('jumpHostId', e.target.value || undefined)}
            >
              <option value="">
                {fromRepo.jumpHostId
                  ? t('From above ({name})', {
                      name: sessions.find((s) => s.id === fromRepo.jumpHostId)?.name ?? t('unknown')
                    })
                  : t('None')}
              </option>
              {/* Only saved sessions can act as a bastion: an inventory host is
                  rebuilt on every sync and its id would not survive a rename. */}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {traits.files && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={override.followTerminalCwd ?? fromRepo.followTerminalCwd}
              onChange={(e) => set('followTerminalCwd', e.target.checked)}
            />
            {t('SFTP panel follows the terminal’s directory')}
          </label>
        )}

        {traits.keyAuth && (
          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={override.agentForward ?? fromRepo.agentForward}
              onChange={(e) => set('agentForward', e.target.checked)}
            />
            {t('Forward SSH agent to remote host')}
          </label>
        )}

        {traits.textual && (
          <>
            <label>
              {t('On connect')}
              <textarea
                rows={2}
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
          </>
        )}

        <label>
          {t('Colour')}
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!override.color ? 'selected' : ''}`}
              title={t('Use the repository’s colour')}
              onClick={() => set('color', undefined)}
            />
            {SESSION_COLOURS.map((c) => (
              <button
                type="button"
                key={c.value}
                className={`swatch ${override.color === c.value ? 'selected' : ''}`}
                style={{ background: c.value }}
                title={c.name}
                onClick={() => set('color', c.value)}
              />
            ))}
          </div>
        </label>

        {traits.textual && (
          <details className="settings-section">
            <summary>{t('Appearance')}</summary>
            <p className="settings-note">
              {t('Kept locally like everything else here, so a sync never takes it away.')}
              {!isHost(node) && ` ${t('Hosts in this group inherit it.')}`}
            </p>
            <AppearanceFields
              value={override}
              set={setLook}
              effective={appearance}
              inherited={inheritedLook}
              inheritedFrom={appearanceFrom}
              inheritToggle={{ label: t('Inherit appearance from the inventory groups') }}
            />
          </details>
        )}

        {isHost(node) && protocolOf(node) === 'rdp' && (
          <details className="settings-section">
            <summary>
              {t('Desktop')}
              <Hint>
                {t(
                'Kept locally, so a sync never takes it away — including a gateway the repository does not know about.'
              )}
              </Hint>
            </summary>
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
          </details>
        )}

        {isHost(node) && (
          <p className="settings-note">
            {t('Connects as')} <strong>{effective.username || t('(no user)')}</strong>@{node.host}:
            {effective.port} {t('using')} {effective.authMethod}
            {effective.jumpHostId
              ? ` ${t('via {name}', {
                  name: sessions.find((s) => s.id === effective.jumpHostId)?.name ?? t('a jump host')
                })}`
              : ''}
            .
          </p>
        )}

        <div className="modal-actions">
          {existing && (
            <button className="danger" onClick={reset}>
              {t('Remove override')}
            </button>
          )}
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={submit}>
            {t('Save')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
