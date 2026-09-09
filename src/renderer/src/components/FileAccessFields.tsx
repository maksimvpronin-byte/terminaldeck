import type { FileAccess } from '../../../shared/types'
import { useT } from '../i18n'

export default function FileAccessFields({
  value,
  onChange
}: {
  value?: FileAccess
  onChange: (value: FileAccess) => void
}): JSX.Element {
  const t = useT()
  return (
    <fieldset>
      <legend>{t('File access')}</legend>
      <label>
        {t('File transfer method')}
        <select
          value={value?.protocol ?? 'sftp'}
          onChange={(e) =>
            onChange({
              protocol: e.target.value as FileAccess['protocol'],
              shell: value?.shell ?? 'sudo -n -i -u postgres'
            })
          }
        >
          <option value="sftp">SFTP</option>
          <option value="scp">SCP / Shell</option>
        </select>
      </label>
      {value?.protocol === 'scp' && (
        <>
          <label>
            {t('Shell launch command')}
            <input
              value={value.shell ?? ''}
              onChange={(e) => onChange({ ...value, shell: e.target.value })}
              placeholder="sudo -n -i -u postgres"
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
