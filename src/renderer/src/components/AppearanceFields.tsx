import type { AppearanceDefaults, CursorStyle, ResolvedAppearance } from '../../../shared/types'
import { FONT_CHOICES, THEME_GROUPS, themeByName } from '../state/settings'

interface Props {
  value: AppearanceDefaults
  set: <K extends keyof AppearanceDefaults>(key: K, value: AppearanceDefaults[K]) => void
  /** What this item ends up looking like once its own values are applied. */
  effective: ResolvedAppearance
  /** What it would look like setting nothing — what each "Inherit" option means. */
  inherited: ResolvedAppearance
  /** Where a blank field's value comes from, e.g. "the group Prod". */
  inheritedFrom: (key: keyof AppearanceDefaults) => string
  /** Only offered when there is something above to inherit from. */
  inheritToggle?: { label: string }
}

const fontLabel = (f: string): string => f.split(',')[0]

/**
 * The appearance half of a session, group or inventory override. Every control
 * offers an explicit "inherit" choice, so leaving the dialog untouched changes
 * nothing — the same contract the credential fields already use.
 */
export default function AppearanceFields({
  value,
  set,
  effective,
  inherited,
  inheritedFrom,
  inheritToggle
}: Props): JSX.Element {
  const preview = themeByName(effective.themeName).terminal
  // Names the value an "Inherit" option would actually give, and where from.
  const via = (key: keyof AppearanceDefaults, shown: string): string =>
    `${shown} from ${inheritedFrom(key)}`

  return (
    <>
      {inheritToggle && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={value.inheritAppearance !== false}
            onChange={(e) => set('inheritAppearance', e.target.checked ? undefined : false)}
          />
          {inheritToggle.label}
        </label>
      )}

      <label>
        Font
        <select
          value={value.fontFamily ?? ''}
          onChange={(e) => set('fontFamily', e.target.value || undefined)}
        >
          <option value="">Inherit ({via('fontFamily', fontLabel(inherited.fontFamily))})</option>
          {FONT_CHOICES.map((f) => (
            <option key={f} value={f}>
              {fontLabel(f)}
            </option>
          ))}
        </select>
      </label>

      <div className="form-row">
        <label>
          Font size
          <input
            type="number"
            min={8}
            max={32}
            value={value.fontSize ?? ''}
            placeholder={via('fontSize', String(inherited.fontSize))}
            onChange={(e) => set('fontSize', e.target.value ? Number(e.target.value) : undefined)}
          />
        </label>
        <label>
          Scrollback (lines)
          <input
            type="number"
            min={100}
            max={200000}
            step={1000}
            value={value.scrollback ?? ''}
            placeholder={via('scrollback', String(inherited.scrollback))}
            onChange={(e) => set('scrollback', e.target.value ? Number(e.target.value) : undefined)}
          />
        </label>
      </div>

      <label>
        Colour theme
        <select
          value={value.themeName ?? ''}
          onChange={(e) => set('themeName', e.target.value || undefined)}
        >
          <option value="">Inherit ({via('themeName', inherited.themeName)})</option>
          {THEME_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <div
        className="theme-preview"
        style={{
          background: preview.background,
          color: preview.foreground,
          fontFamily: effective.fontFamily,
          fontSize: effective.fontSize
        }}
      >
        <div>
          <span style={{ color: preview.green ?? preview.foreground }}>user@host</span>:
          <span style={{ color: preview.blue ?? preview.foreground }}>~</span>${' '}
          <span>ls -la</span>
        </div>
        <div style={{ color: preview.red ?? preview.foreground }}>permission denied</div>
      </div>

      <div className="form-row">
        <label>
          Cursor style
          <select
            value={value.cursorStyle ?? ''}
            onChange={(e) => set('cursorStyle', (e.target.value || undefined) as CursorStyle)}
          >
            <option value="">Inherit ({via('cursorStyle', inherited.cursorStyle)})</option>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </label>
        <label>
          Cursor blink
          {/* Three states, so a checkbox will not do: off is a real choice that
              has to outrank an inherited on. */}
          <select
            value={value.cursorBlink === undefined ? '' : value.cursorBlink ? 'on' : 'off'}
            onChange={(e) =>
              set('cursorBlink', e.target.value === '' ? undefined : e.target.value === 'on')
            }
          >
            <option value="">
              Inherit ({via('cursorBlink', inherited.cursorBlink ? 'blinking' : 'steady')})
            </option>
            <option value="on">Blinking</option>
            <option value="off">Steady</option>
          </select>
        </label>
      </div>
    </>
  )
}
