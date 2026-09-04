import type { AuthDefaults, AuthMethod } from '../../../shared/types'
import type { AuthFieldsState, CredentialSource } from '../../../shared/authFields'
import { useT, type Translate } from '../i18n'
import Hint from './Hint'

/**
 * The words that differ between the three places this is used. The controls do
 * not differ; the prose does, because a group's credential and a host's mean
 * different things to whoever reads the sentence.
 */
export interface AuthWords {
  /** The option that takes the value from above: "Inherit", "From the inventory". */
  inherit: string
  /** After the field name: "(saved on this group)". */
  secretHint: string
  /** How this item calls itself in prose: "this host". */
  self: string
  /** Said while the item holds a credential of its own. */
  held: string
  /** …and instead, once forgetting it is pending. */
  forget: string
  /** The placeholder in the key-file box when it is empty. */
  keyPath: string
}

interface Props {
  value: AuthDefaults
  set: <K extends keyof AuthDefaults>(key: K, value: AuthDefaults[K]) => void
  /** The rules behind all of this — see shared/authFields.ts. */
  state: AuthFieldsState
  /** A credential typed in now, which has not been saved yet. */
  secret: string
  onSecret: (value: string) => void
  /** Whether saving should drop the credential this item holds. */
  forgetSecret: boolean
  onForgetSecret: (forget: boolean) => void
  /** Opens a file picker and keeps the path; the caller owns both. */
  onPickKey: () => void
  /**
   * The methods this item may actually use, in the order to offer them.
   *
   * A host knows what it speaks, and RDP authenticates with a password and
   * nothing else — a key file or an agent there is a choice that cannot be
   * honoured. A group is not asked and gets all three: protocol is not
   * inherited, and one group holds Linux and Windows boxes alike.
   */
  methods?: AuthMethod[]
  words: AuthWords
}

const ALL_METHODS: AuthMethod[] = ['password', 'privateKey', 'agent']

/**
 * Literal phrases in a function rather than a table looked up by key: the
 * phrase book's coverage test reads the source for `t('…')`, and a key
 * assembled at runtime is invisible to it.
 */
function methodLabel(t: Translate, method: AuthMethod): string {
  if (method === 'password') return t('Password')
  if (method === 'privateKey') return t('Private key')
  return t('SSH agent')
}

/**
 * The credential half of a session, a group or an inventory override.
 *
 * These three dialogs each had their own copy of this, which is how they came
 * to disagree: one stored a password under agent authentication, one showed no
 * passphrase box at all, and only one warned when a key file and its passphrase
 * came from different places. Following `AppearanceFields` and `RdpFields`,
 * which solve the same shape for the other two halves of the same dialogs.
 */
export default function AuthFields({
  value,
  set,
  state,
  secret,
  onSecret,
  forgetSecret,
  onForgetSecret,
  onPickKey,
  methods = ALL_METHODS,
  words
}: Props): JSX.Element {
  const t = useT()
  const { shownMethod, inheritedMethod, ownSecret, splitCredential, keyFrom, passphraseFrom } =
    state

  /**
   * Taking the method from above takes the credential with it: the item's own
   * is dropped in the same move, so it stops shadowing what it is meant to be
   * inheriting. Choosing a method again keeps it, and the note below says which
   * way it currently stands, so neither is silent.
   */
  function choose(method: string): void {
    set('authMethod', (method || undefined) as AuthMethod)
    if (ownSecret) onForgetSecret(method === '')
  }

  const nameOf = (source: CredentialSource): string =>
    source === 'self' ? words.self : (source?.name ?? '')

  /**
   * What is offered, plus whatever is already set if that is not among them.
   *
   * A host saved as RDP while it was still SSH can hold `privateKey`. Dropping
   * the option would leave the select showing nothing at all and change the
   * stored value the moment anyone touched it, which is a poor way to learn
   * that a setting was quietly wrong.
   */
  const offered =
    value.authMethod && !methods.includes(value.authMethod)
      ? [...methods, value.authMethod]
      : methods

  return (
    <>
      <label>
        {t('Auth method')}
        <select value={value.authMethod ?? ''} onChange={(e) => choose(e.target.value)}>
          <option value="">
            {words.inherit} ({inheritedMethod})
          </option>
          {offered.map((method) => (
            <option key={method} value={method}>
              {methodLabel(t, method)}
            </option>
          ))}
        </select>
      </label>

      {shownMethod === 'password' && (
        <label>
          {t('Password')} {words.secretHint}
          <input type="password" value={secret} onChange={(e) => onSecret(e.target.value)} />
        </label>
      )}

      {shownMethod === 'privateKey' && (
        <>
          <div className="form-row">
            <label style={{ flex: 1 }}>
              {t('Private key file')}
              <input readOnly value={value.privateKeyPath ?? ''} placeholder={words.keyPath} />
            </label>
            <button style={{ alignSelf: 'flex-end' }} onClick={onPickKey}>
              {t('Browse…')}
            </button>
          </div>
          <label>
            {t('Passphrase')} {words.secretHint}
            <input type="password" value={secret} onChange={(e) => onSecret(e.target.value)} />
          </label>
        </>
      )}

      {/* Left in English: the names sit inside the sentence, and the phrase
          book matches whole strings rather than filling in blanks. */}
      {splitCredential && (
        <p className="settings-note warning-note">
          The key file comes from {nameOf(keyFrom)} and the passphrase from {nameOf(passphraseFrom)}
          . A passphrase saved for a different key will not open this one.
        </p>
      )}

      {/* State and an action, so only the explanation goes under the mark. The
          sentence says which way this currently stands, and the button changes
          it — neither is something to go looking for behind a hover. */}
      {shownMethod !== 'agent' && ownSecret && (
        <p className="settings-note action-note">
          {forgetSecret ? t('Will be forgotten on save') : t('Saved on this host')}
          {/* No space written between them: the mark carries its own margin on
              both sides, and a space here is added to the right one only. */}
          <Hint>{forgetSecret ? words.forget : words.held}</Hint>
          <button type="button" onClick={() => onForgetSecret(!forgetSecret)}>
            {forgetSecret ? t('Keep it') : t('Forget it')}
          </button>
        </p>
      )}
    </>
  )
}
