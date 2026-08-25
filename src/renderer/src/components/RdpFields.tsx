import type { RdpDefaults, RdpResolution, ResolvedRdp } from '../../../shared/types'

interface Props {
  value: RdpDefaults
  set: <K extends keyof RdpDefaults>(key: K, value: RdpDefaults[K]) => void
  /** What this item ends up connecting with once its own values are applied. */
  effective: ResolvedRdp
  /** Where a blank field's value comes from, e.g. "inherited from Prod". */
  inheritedFrom: (key: keyof RdpDefaults) => string
  /** Only offered when there is something above to inherit from. */
  inheritToggle?: { label: string }
  /**
   * The gateway password, typed here and stored by whoever owns the dialog —
   * the same contract the login password already uses, since a secret must not
   * be held in a value the component renders from a second time.
   */
  secret: { typed: string; onTyped: (value: string) => void; own: boolean; forget: boolean; onForget: (forget: boolean) => void }
}

/**
 * The desktop half of a session, a group or an inventory override: how a host
 * is reached, how big its screen is, and what the ⌘ key does over it.
 *
 * Every control offers inheritance, so a gateway shared by a whole floor of
 * machines is stated once on the group and left blank on each host.
 */
export default function RdpFields({
  value,
  set,
  effective,
  inheritedFrom,
  inheritToggle,
  secret
}: Props): JSX.Element {
  return (
    <>
      {inheritToggle && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={value.inheritRdp !== false}
            onChange={(e) => set('inheritRdp', e.target.checked ? undefined : false)}
          />
          {inheritToggle.label}
        </label>
      )}

      <p className="settings-note">
        A gateway says where a machine lives rather than who you are on it, so it is usually
        stated once on a group and left blank below. Blank reaches the host directly.
      </p>

      <div className="form-row">
        <label style={{ flex: 3 }}>
          RD Gateway
          <input
            value={value.gatewayHost ?? ''}
            placeholder={inheritedFrom('gatewayHost') || 'none — connect directly'}
            onChange={(e) => set('gatewayHost', e.target.value || undefined)}
          />
        </label>
        <label style={{ flex: 1 }}>
          Port
          <input
            type="number"
            value={value.gatewayPort ?? ''}
            placeholder={String(effective.gatewayPort)}
            onChange={(e) => set('gatewayPort', e.target.value ? Number(e.target.value) : undefined)}
          />
        </label>
      </div>

      {effective.gatewayHost && (
        <>
          <div className="form-row">
            <label style={{ flex: 1 }}>
              Gateway username
              <input
                value={value.gatewayUsername ?? ''}
                placeholder={inheritedFrom('gatewayUsername') || "the host's own login"}
                onChange={(e) => set('gatewayUsername', e.target.value || undefined)}
              />
            </label>
            <label style={{ flex: 1 }}>
              Gateway password
              <input
                type="password"
                value={secret.typed}
                placeholder={
                  secret.own && !secret.forget ? '(saved here)' : "(blank uses the host's own)"
                }
                onChange={(e) => secret.onTyped(e.target.value)}
              />
            </label>
          </div>

          {secret.own && (
            <p className="settings-note">
              {secret.forget
                ? 'On save the gateway password stored here is forgotten.'
                : 'A gateway password is stored here, and the nearest value wins.'}{' '}
              <button type="button" onClick={() => secret.onForget(!secret.forget)}>
                {secret.forget ? 'Keep it' : 'Forget it'}
              </button>
            </p>
          )}

          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={effective.gatewayBypassLocal}
              onChange={(e) => set('gatewayBypassLocal', e.target.checked)}
            />
            Reach private addresses directly, without the gateway
          </label>
        </>
      )}

      <div className="form-row">
        <label style={{ flex: 1 }}>
          Resolution
          <select
            value={value.resolution ?? ''}
            onChange={(e) => set('resolution', (e.target.value || undefined) as RdpResolution)}
          >
            <option value="">
              Inherit ({inheritedFrom('resolution') ? effective.resolution : 'fit'})
            </option>
            <option value="fit">Fit the pane</option>
            <option value="fixed">Fixed size</option>
          </select>
        </label>
        {effective.resolution === 'fixed' && (
          <>
            <label style={{ flex: 1 }}>
              Width
              <input
                type="number"
                value={value.desktopWidth ?? ''}
                placeholder={String(effective.desktopWidth)}
                onChange={(e) =>
                  set('desktopWidth', e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </label>
            <label style={{ flex: 1 }}>
              Height
              <input
                type="number"
                value={value.desktopHeight ?? ''}
                placeholder={String(effective.desktopHeight)}
                onChange={(e) =>
                  set('desktopHeight', e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </label>
          </>
        )}
      </div>
      <p className="settings-note">
        {effective.resolution === 'fixed'
          ? 'The desktop keeps this size and is scaled into the pane.'
          : 'The far end is asked to match the pane whenever it is resized, so every pixel stays its own.'}
      </p>

      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={effective.hiDpi}
          onChange={(e) => set('hiDpi', e.target.checked)}
        />
        Use the screen's full resolution
      </label>
      <p className="settings-note">
        On a Retina display this asks the far end for twice as many pixels in each direction, so
        the desktop is sharp and twice as much of it fits — windows and text stop looking
        oversized. It is four times the pixels to send and draw, so on a slow link it is the
        first thing to turn off.
      </p>

      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={effective.commandAsControl}
          onChange={(e) => set('commandAsControl', e.target.checked)}
        />
        Send ⌘ as Ctrl
      </label>
      <p className="settings-note">
        Copy and paste then land where they do on Windows. While the desktop has the keyboard this
        app's own ⌘ shortcuts do not fire; ⌘Q and ⌘Tab still belong to macOS.
      </p>
    </>
  )
}
