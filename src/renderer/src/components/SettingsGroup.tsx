import { useId, type ReactNode } from 'react'
import Hint from './Hint'

/**
 * A titled card of settings that belong together — "Behaviour", "Cursor",
 * "Master password".
 *
 * The pages used to be one column of controls with a bold line now and then,
 * which made a page of twelve settings read as twelve settings rather than as
 * three things to decide. A card says where one thing ends.
 */
export function SettingsGroup({
  title,
  hint,
  children
}: {
  title?: ReactNode
  /** What the whole card is about, behind the question mark beside its title. */
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className="settings-group">
      {title && (
        <h3 className="settings-group-title">
          {title}
          {hint && <Hint>{hint}</Hint>}
        </h3>
      )}
      <div className="settings-group-body">{children}</div>
    </section>
  )
}

/**
 * One setting on one line: what it is at the left, the control at the right,
 * and a line of small print under the caption when a question mark would hide
 * something worth reading.
 *
 * The caption is a `label` tied to the control by id rather than wrapped round
 * it. Wrapped, the label's control is its first focusable descendant, and with
 * a question mark in the caption that is the mark — a click on the words would
 * open the hint instead of reaching the setting.
 */
export function SettingRow({
  label,
  note,
  hint,
  controlId,
  stacked,
  children
}: {
  label: ReactNode
  note?: ReactNode
  hint?: ReactNode
  /** The control the caption names, so a click on the words reaches it. */
  controlId?: string
  /** Caption above and control below, for a control that wants the full width. */
  stacked?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`setting-row${stacked ? ' stacked' : ''}`}>
      <div className="setting-text">
        <span className="setting-label">
          <label htmlFor={controlId}>{label}</label>
          {hint && <Hint>{hint}</Hint>}
        </span>
        {note && <span className="setting-note">{note}</span>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

/** A yes-or-no setting, drawn as a switch: the commonest row by far. */
export function SwitchRow({
  label,
  note,
  hint,
  checked,
  onChange
}: {
  label: ReactNode
  note?: ReactNode
  hint?: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  const id = useId()
  return (
    <SettingRow label={label} note={note} hint={hint} controlId={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </SettingRow>
  )
}
