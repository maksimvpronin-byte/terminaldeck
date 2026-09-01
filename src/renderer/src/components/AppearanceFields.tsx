import type { AppearanceDefaults, CursorStyle, ResolvedAppearance } from '../../../shared/types'
import { FONT_CHOICES, THEME_GROUPS, themeByName } from '../state/settings'
import { useT, type Translate } from '../i18n'

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
/**
 * A cursor style in words, written as literals rather than looked up.
 *
 * `t(style)` would be shorter and would not work: the phrase book's coverage
 * test reads the source for `t('…')`, so a key assembled at runtime is
 * invisible to it — the entry is never demanded and the interface quietly shows
 * the English. The same reason `methodLabel` in AuthFields is written this way.
 */
function cursorName(t: Translate, style: CursorStyle): string {
  if (style === 'block') return t('Block')
  if (style === 'underline') return t('Underline')
  return t('Bar')
}

export default function AppearanceFields({
  value,
  set,
  effective,
  inherited,
  inheritedFrom,
  inheritToggle
}: Props): JSX.Element {
  const t = useT()
  const preview = themeByName(effective.themeName).terminal
  /**
   * Names the value an "Inherit" option would actually give, and where from.
   *
   * Assembled through the phrase book rather than with a template, because
   * "X from Y" is a sentence and not every language builds it in that order.
   */
  const via = (key: keyof AppearanceDefaults, shown: string): string =>
    t('{value} from {source}', { value: shown, source: inheritedFrom(key) })

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
        {t('Font')}
        <select
          value={value.fontFamily ?? ''}
          onChange={(e) => set('fontFamily', e.target.value || undefined)}
        >
          <option value="">
            {t('Inherit')} ({via('fontFamily', fontLabel(inherited.fontFamily))})
          </option>
          {FONT_CHOICES.map((f) => (
            <option key={f} value={f}>
              {fontLabel(f)}
            </option>
          ))}
        </select>
      </label>

      <div className="form-row">
        <label>
          {t('Font size')}
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
          {t('Scrollback (lines)')}
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
        {t('Colour theme')}
        <select
          value={value.themeName ?? ''}
          onChange={(e) => set('themeName', e.target.value || undefined)}
        >
          <option value="">
            {t('Inherit')} ({via('themeName', inherited.themeName)})
          </option>
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
          <span style={{ color: preview.blue ?? preview.foreground }}>~</span>$ <span>ls -la</span>
        </div>
        <div style={{ color: preview.red ?? preview.foreground }}>permission denied</div>
      </div>

      {/* One to a row. These carry the longest text in the dialog — the value
          and where it comes from — and half a row is not enough for it: the
          name was cut off mid-word, which is the one part somebody needs to
          read. */}
      <label>
        {t('Cursor style')}
        <select
          value={value.cursorStyle ?? ''}
          onChange={(e) => set('cursorStyle', (e.target.value || undefined) as CursorStyle)}
        >
          <option value="">
            {t('Inherit')} ({via('cursorStyle', cursorName(t, inherited.cursorStyle))})
          </option>
          <option value="block">{t('Block')}</option>
          <option value="underline">{t('Underline')}</option>
          <option value="bar">{t('Bar')}</option>
        </select>
      </label>
      <label>
        {t('Cursor blink')}
        {/* Three states, so a checkbox will not do: off is a real choice that
              has to outrank an inherited on. */}
        <select
          value={value.cursorBlink === undefined ? '' : value.cursorBlink ? 'on' : 'off'}
          onChange={(e) =>
            set('cursorBlink', e.target.value === '' ? undefined : e.target.value === 'on')
          }
        >
          <option value="">
            {t('Inherit')} (
            {via('cursorBlink', inherited.cursorBlink ? t('blinking') : t('steady'))})
          </option>
          <option value="on">{t('Blinking')}</option>
          <option value="off">{t('Steady')}</option>
        </select>
      </label>
    </>
  )
}
