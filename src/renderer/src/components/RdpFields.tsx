import type { RdpDefaults, RdpResolution, ResolvedRdp } from '../../../shared/types'
import Hint from './Hint'
import { useT } from '../i18n'

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
  secret: {
    typed: string
    onTyped: (value: string) => void
    own: boolean
    forget: boolean
    onForget: (forget: boolean) => void
  }
}

/**
 * A resolution in words, written as literals rather than looked up.
 *
 * `t(resolution)` would be shorter and invisible to the phrase book's coverage
 * test, which reads the source for `t('…')` — so the entry would never be
 * demanded and the list would go on saying "fit" in a translated dialog, which
 * is exactly what it was doing.
 */
function resolutionName(t: (text: string) => string, resolution: string): string {
  return resolution === 'fixed' ? t('Fixed size') : t('Fit the pane')
}

/** What a blank sizing field ends up doing, in the words the list itself uses. */
function sizingLabel(t: (text: string) => string, effective: ResolvedRdp): string {
  if (effective.sendDensity) return t('The far end lays itself out larger')
  if (effective.magnification === 100) return t('Do not adjust — every pixel its own')
  if (effective.magnification === 0) return t('As much as this display needs')
  return `${effective.magnification}%`
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
  const t = useT()

  /**
   * Which of the two ways of getting the size right this item states.
   *
   * These were two controls — a checkbox and a percentage — answering one
   * question between them: ticking the box greyed the select out entirely. Two
   * controls for one mutually exclusive choice is a shape that invites someone
   * to set a percentage, tick the box, and wonder why nothing happened.
   *
   * Underneath they are still two settings. They inherit separately, and only
   * one of them is anything the far end is ever told about.
   */
  const sizing =
    value.sendDensity === undefined && value.magnification === undefined
      ? ''
      : value.sendDensity
        ? 'remote'
        : String(value.magnification ?? effective.magnification)

  function chooseSizing(choice: string): void {
    if (choice === '') {
      set('sendDensity', undefined)
      set('magnification', undefined)
      return
    }
    if (choice === 'remote') {
      set('sendDensity', true)
      /* The percentage is left as it stands rather than cleared: it is what a
         host too old to act on the density falls back to, and clearing it here
         would change that fallback without saying so. */
      return
    }
    set('sendDensity', false)
    set('magnification', Number(choice))
  }

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

      <div className="form-row">
        <label style={{ flex: 3 }}>
          <Hint label={t('RD Gateway')}>
            {t(
              'A gateway says where a machine lives rather than who you are on it, so it is usually stated once on a group and left blank below. Blank reaches the host directly.'
            )}
          </Hint>
          <input
            value={value.gatewayHost ?? ''}
            placeholder={inheritedFrom('gatewayHost') || t('none — connect directly')}
            onChange={(e) => set('gatewayHost', e.target.value || undefined)}
          />
        </label>
        <label style={{ flex: 1 }}>
          {t('Port')}
          <input
            type="number"
            value={value.gatewayPort ?? ''}
            placeholder={String(effective.gatewayPort)}
            onChange={(e) =>
              set('gatewayPort', e.target.value ? Number(e.target.value) : undefined)
            }
          />
        </label>
      </div>

      {effective.gatewayHost && (
        <>
          <div className="form-row">
            <label style={{ flex: 1 }}>
              {t('Gateway username')}
              <input
                value={value.gatewayUsername ?? ''}
                placeholder={inheritedFrom('gatewayUsername') || t("the host's own login")}
                onChange={(e) => set('gatewayUsername', e.target.value || undefined)}
              />
            </label>
            <label style={{ flex: 1 }}>
              {t('Gateway password')}
              <input
                type="password"
                value={secret.typed}
                placeholder={
                  secret.own && !secret.forget
                    ? t('(saved here)')
                    : t("(blank uses the host's own)")
                }
                onChange={(e) => secret.onTyped(e.target.value)}
              />
            </label>
          </div>

          {secret.own && (
            <p className="settings-note action-note">
              {secret.forget ? t('Will be forgotten on save') : t('Saved on this host')}
              <Hint>
                {secret.forget
                  ? t('On save the gateway password stored here is forgotten.')
                  : t('A gateway password is stored here, and the nearest value wins.')}
              </Hint>
              <button type="button" onClick={() => secret.onForget(!secret.forget)}>
                {secret.forget ? t('Keep it') : t('Forget it')}
              </button>
            </p>
          )}

          <label className="checkbox-row" style={{ flexDirection: 'row' }}>
            <input
              type="checkbox"
              checked={effective.gatewayBypassLocal}
              onChange={(e) => set('gatewayBypassLocal', e.target.checked)}
            />
            {t('Reach private addresses directly, without the gateway')}
          </label>
        </>
      )}

      <div className="form-row">
        <label style={{ flex: 1 }}>
          <Hint label={t('Resolution')}>
            {/* Says what the current choice does, not what the setting is for:
                the two answers are different enough to be worth reading. */}
            {effective.resolution === 'fixed'
              ? t('The desktop keeps this size and is scaled into the pane.')
              : t(
                  'The far end is asked to match the pane whenever it is resized, so every pixel stays its own.'
                )}
          </Hint>
          <select
            value={value.resolution ?? ''}
            onChange={(e) => set('resolution', (e.target.value || undefined) as RdpResolution)}
          >
            <option value="">
              {t('Inherit')} (
              {resolutionName(t, inheritedFrom('resolution') ? effective.resolution : 'fit')})
            </option>
            <option value="fit">{t('Fit the pane')}</option>
            <option value="fixed">{t('Fixed size')}</option>
          </select>
        </label>
      </div>

      {effective.resolution === 'fixed' && (
        <div className="form-row">
          <label style={{ flex: 1 }}>
            {t('Width')}
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
            {t('Height')}
            <input
              type="number"
              value={value.desktopHeight ?? ''}
              placeholder={String(effective.desktopHeight)}
              onChange={(e) =>
                set('desktopHeight', e.target.value ? Number(e.target.value) : undefined)
              }
            />
          </label>
        </div>
      )}

      <label>
        <Hint label={t('Most pixels to ask for')}>
          {t(
            "Counted in the screen's own pixels, so a Retina pane can ask for up to four times the data. On an ordinary monitor nothing here changes anything."
          )}
        </Hint>
        <select
          value={String(effective.pixelBudget)}
          onChange={(e) => set('pixelBudget', Number(e.target.value))}
        >
          <option value="1.5">{t('Fewest — a slow link')}</option>
          <option value="3.5">{t('Balanced')}</option>
          <option value="100">{t('As many as the screen has')}</option>
        </select>
      </label>
      <label>
        <Hint label={t('How the desktop is made the right size')}>
          {t(
            'Asking the far end is the only way to get the right size at full sharpness, and Windows 8.1 and later act on it; older versions ignore it and the desktop stays as it was. Stretching here always works and costs sharpness.'
          )}
        </Hint>
        <select value={sizing} onChange={(e) => chooseSizing(e.target.value)}>
          <option value="">
            {t('Inherit')} ({sizingLabel(t, effective)})
          </option>
          <option value="remote">{t('The far end lays itself out larger')}</option>
          <optgroup label={t('Stretch the picture on this side')}>
            <option value="0">{t('As much as this display needs')}</option>
            <option value="125">125%</option>
            <option value="150">150%</option>
            <option value="200">200%</option>
            <option value="300">300%</option>
          </optgroup>
          <option value="100">{t('Do not adjust — every pixel its own')}</option>
        </select>
      </label>
      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={effective.sound}
          onChange={(e) => set('sound', e.target.checked)}
        />
        <Hint label={t('Play the remote sound here')}>
          {t(
            'Played by the desktop client itself, so it costs this side nothing and the link something.'
          )}
        </Hint>
      </label>
      <label className="checkbox-row" style={{ flexDirection: 'row' }}>
        <input
          type="checkbox"
          checked={effective.commandAsControl}
          onChange={(e) => set('commandAsControl', e.target.checked)}
        />
        <Hint label={t('Send ⌘ as Ctrl')}>
          {t(
            "Copy and paste then land where they do on Windows. While the desktop has the keyboard this app's own ⌘ shortcuts do not fire; ⌘Q and ⌘Tab still belong to macOS."
          )}
        </Hint>
      </label>
    </>
  )
}
