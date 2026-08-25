import { useState } from 'react'
import type {
  AppearanceDefaults,
  AuthMethod,
  InventoryOverride,
  RdpDefaults,
  SessionGroup,
  SessionProfile
} from '../../../shared/types'
import { resolveAuth } from '../../../shared/authResolution'
import { applyOverride, isSet } from '../../../shared/overrides'
import { appearanceSource, resolveAppearance } from '../../../shared/appearance'
import { resolveRdp } from '../../../shared/rdpResolution'
import { protocolOf } from '../../../shared/protocols'
import { useStore } from '../state/store'
import { SESSION_COLOURS } from '../state/colours'
import AppearanceFields from './AppearanceFields'
import RdpFields from './RdpFields'
import ModalBackdrop from './ModalBackdrop'

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

  // A group inherits from its parent; a host from the group it sits in.
  const parentId = isHost(node) ? node.groupId : node.parentId
  // What the repository alone would give this node, ignoring the override.
  const fromRepo = resolveAuth(node, parentId, groups)
  const effective = resolveAuth({ ...node, ...override }, parentId, groups)

  // Appearance layers the same way: the override, then what the repository and
  // its groups say, then the application-wide settings.
  const merged = applyOverride(node, override)
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
    // A password typed in now beats the "forget" tick — it is the later answer.
    await saveInventoryOverride(
      toSave,
      secret || (forgetSecret ? null : undefined),
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
          Local settings for {isHost(node) ? node.name : `group ${node.name}`}
        </h2>
        <p className="settings-note">
          Kept outside the repository and re-applied after every sync, so pulling never discards
          them. Leave a field blank to keep what the inventory says.
          {!isHost(node) && ' Everything in this group inherits what you set here.'}
        </p>

        <div className="form-row">
          <label style={{ flex: 3 }}>
            Username
            <input
              autoFocus
              value={override.username ?? ''}
              placeholder={fromRepo.username || 'not set in the inventory'}
              onChange={(e) => set('username', e.target.value)}
            />
          </label>
          <label style={{ flex: 1 }}>
            Port
            <input
              type="number"
              value={override.port ?? ''}
              placeholder={String(fromRepo.port)}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : undefined)}
            />
          </label>
        </div>

        <label>
          Auth method
          <select
            value={override.authMethod ?? ''}
            onChange={(e) => {
              set('authMethod', (e.target.value || undefined) as AuthMethod)
              // Handing the method back to the inventory hands the credential
              // back with it, rather than leaving a local password in the way.
              if (isSet(override.secretRef)) setForgetSecret(e.target.value === '')
            }}
          >
            <option value="">From the inventory ({fromRepo.authMethod})</option>
            <option value="password">Password</option>
            <option value="privateKey">Private key</option>
            <option value="agent">SSH agent</option>
          </select>
        </label>

        {effective.authMethod === 'password' && (
          <label>
            Password{' '}
            {isSet(override.secretRef) && !forgetSecret
              ? '(saved here, and it overrides the inventory)'
              : '(leave blank to keep the current one)'}
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </label>
        )}

        {isSet(override.secretRef) && effective.authMethod !== 'agent' && (
          <p className="settings-note">
            {forgetSecret
              ? 'On save this password is forgotten, and the host is asked for one on connect.'
              : 'This password is kept locally for this host alone, so nothing set on a group above it is used.'}{' '}
            <button type="button" onClick={() => setForgetSecret(!forgetSecret)}>
              {forgetSecret ? 'Keep it' : 'Forget it'}
            </button>
          </p>
        )}

        {effective.authMethod === 'privateKey' && (
          <div className="form-row">
            <label style={{ flex: 1 }}>
              Private key file
              <input
                readOnly
                value={override.privateKeyPath ?? ''}
                placeholder={fromRepo.privateKeyPath ?? 'No file selected'}
              />
            </label>
            <button style={{ alignSelf: 'flex-end' }} onClick={pickKey}>
              Browse…
            </button>
          </div>
        )}

        <label>
          Jump host (ProxyJump)
          <select
            value={override.jumpHostId ?? ''}
            onChange={(e) => set('jumpHostId', e.target.value || undefined)}
          >
            <option value="">
              {fromRepo.jumpHostId
                ? `From above (${sessions.find((s) => s.id === fromRepo.jumpHostId)?.name ?? 'unknown'})`
                : 'None'}
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

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={override.followTerminalCwd ?? fromRepo.followTerminalCwd}
            onChange={(e) => set('followTerminalCwd', e.target.checked)}
          />
          SFTP panel follows the terminal&apos;s directory
        </label>

        <label className="checkbox-row" style={{ flexDirection: 'row' }}>
          <input
            type="checkbox"
            checked={override.agentForward ?? fromRepo.agentForward}
            onChange={(e) => set('agentForward', e.target.checked)}
          />
          Forward SSH agent to remote host
        </label>

        <label>
          On connect
          <textarea
            rows={2}
            value={override.onConnectCommand ?? ''}
            placeholder="e.g. sudo -i"
            onChange={(e) => set('onConnectCommand', e.target.value)}
          />
        </label>
        <p className="settings-note">
          Set here and nowhere else: this is never read from the repository. It is arbitrary
          code run on every connection, and honouring it from a repo would hand command
          execution to anyone able to commit there.
        </p>

        <label>
          Colour
          <div className="colour-row">
            <button
              type="button"
              className={`swatch none ${!override.color ? 'selected' : ''}`}
              title="Use the repository's colour"
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

        <details className="settings-section">
          <summary>Appearance</summary>
          <p className="settings-note">
            Kept locally like everything else here, so a sync never takes it away.
            {!isHost(node) && ' Hosts in this group inherit it.'}
          </p>
          <AppearanceFields
            value={override}
            set={setLook}
            effective={appearance}
            inherited={inheritedLook}
            inheritedFrom={appearanceFrom}
            inheritToggle={{ label: 'Inherit appearance from the inventory groups' }}
          />
        </details>

        {isHost(node) && protocolOf(node) === 'rdp' && (
          <details className="settings-section">
            <summary>Desktop</summary>
            <p className="settings-note">
              Kept locally, so a sync never takes it away — including a gateway the repository
              does not know about.
            </p>
            <RdpFields
              value={override}
              set={setRdp}
              effective={desktop}
              inheritedFrom={rdpFrom}
              inheritToggle={{ label: 'Inherit desktop settings from the inventory groups' }}
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
            Connects as <strong>{effective.username || '(no user)'}</strong>@{node.host}:
            {effective.port} using {effective.authMethod}
            {effective.jumpHostId
              ? ` via ${sessions.find((s) => s.id === effective.jumpHostId)?.name ?? 'a jump host'}`
              : ''}
            .
          </p>
        )}

        <div className="modal-actions">
          {existing && (
            <button className="danger" onClick={reset}>
              Remove override
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
