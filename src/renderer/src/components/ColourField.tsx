import { SESSION_COLOURS } from '../state/colours'
import { useT } from '../i18n'
import { SettingRow } from './SettingsGroup'

/**
 * The row of colour swatches a host, a group and a repository each carry —
 * written out four times over until the dialogs were laid out in pages.
 */
export default function ColourField({
  value,
  onChange,
  noneTitle
}: {
  value: string | undefined
  onChange: (colour: string | undefined) => void
  /** What the empty swatch means here: no colour, or the one from above. */
  noneTitle?: string
}): JSX.Element {
  const t = useT()
  return (
    <SettingRow label={t('Colour')}>
      <div className="colour-row">
        <button
          type="button"
          className={`swatch none ${!value ? 'selected' : ''}`}
          title={noneTitle ?? t('No colour')}
          onClick={() => onChange(undefined)}
        />
        {SESSION_COLOURS.map((c) => (
          <button
            type="button"
            key={c.value}
            className={`swatch ${value === c.value ? 'selected' : ''}`}
            style={{ background: c.value }}
            title={c.name}
            onClick={() => onChange(c.value)}
          />
        ))}
      </div>
    </SettingRow>
  )
}
