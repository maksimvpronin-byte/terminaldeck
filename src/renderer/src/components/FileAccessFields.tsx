import type { FileAccess } from '../../../shared/types'
import { useT } from '../i18n'

const DEFAULT_SHELL = 'sudo -n -i -u postgres'

function methodLabel(access?: FileAccess): string {
  return access?.protocol === 'scp' ? 'SCP / Shell' : 'SFTP'
}

/**
 * How the file panel reaches this host's files.
 *
 * `value` is what is set here; `inherited` is what the level above hands down,
 * and is offered as a choice of its own wherever there is a level above — a
 * group, or a host inside one. Without that choice a group could not say
 * "everything in here goes through sudo", and a host that had once been
 * switched could never be handed back to its group.
 */
export default function FileAccessFields({
  value,
  inherited,
  canInherit = false,
  inheritedFrom,
  onChange
}: {
  value?: FileAccess
  inherited?: FileAccess
  /** Whether there is anything above this level to inherit from. */
  canInherit?: boolean
  /** Where the inherited method comes from, e.g. "inherited from Prod". */
  inheritedFrom?: string
  onChange: (value: FileAccess | undefined) => void
}): JSX.Element {
  const t = useT()
  const inheriting = canInherit && !value
  const effective = value ?? inherited
  return (
    <fieldset>
      <legend>{t('File access')}</legend>
      <label>
        {t('File transfer method')}
        <select
          value={inheriting ? '' : (effective?.protocol ?? 'sftp')}
          title={inheriting ? inheritedFrom || undefined : undefined}
          onChange={(e) => {
            if (!e.target.value) {
              onChange(undefined)
              return
            }
            onChange({
              protocol: e.target.value as FileAccess['protocol'],
              shell: value?.shell ?? inherited?.shell ?? DEFAULT_SHELL
            })
          }}
        >
          {canInherit && (
            <option value="">
              {t('Inherit')} ({methodLabel(inherited)})
            </option>
          )}
          <option value="sftp">SFTP</option>
          <option value="scp">SCP / Shell</option>
        </select>
      </label>
      {effective?.protocol === 'scp' && (
        <>
          <label>
            {t('Shell launch command')}
            <input
              value={inheriting ? (inherited?.shell ?? '') : (value?.shell ?? '')}
              disabled={inheriting}
              title={inheriting ? inheritedFrom || undefined : undefined}
              onChange={(e) => onChange({ protocol: 'scp', shell: e.target.value })}
              placeholder={DEFAULT_SHELL}
            />
          </label>
          <p className="settings-note">
            {t(
              'Linux server with scp and GNU coreutils/find required. The command must allow non-interactive execution; sudo password prompts are not supported. Applies to files after reconnecting, independently of the terminal login.'
            )}
          </p>
        </>
      )}
    </fieldset>
  )
}
