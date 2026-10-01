import { useState, type InputHTMLAttributes } from 'react'
import { useT } from '../i18n'
import { EyeIcon, EyeOffIcon } from './icons'

/**
 * A password field with an eye beside it that shows what was typed.
 *
 * A master password is long, typed blind, and asked for twice when it is made
 * or changed; one wrong key and the only way to find it was to clear the field
 * and start again. Shown only while asked for, and hidden again whenever the
 * field is mounted afresh.
 *
 * The eye is reached with the mouse and not with Tab. Tab out of the field
 * goes to the button that submits it, as it always has — on the lock screen
 * that order is what keeps the keyboard inside the dialog — and pressing the
 * eye leaves the caret where it was, so typing carries straight on.
 */
export default function PasswordInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>
): JSX.Element {
  const t = useT()
  const [shown, setShown] = useState(false)
  const label = shown ? t('Hide password') : t('Show password')
  return (
    <span className="password-input">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="password-eye"
        tabIndex={-1}
        aria-label={label}
        aria-pressed={shown}
        title={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </span>
  )
}
