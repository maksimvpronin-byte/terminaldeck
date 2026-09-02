import { useState } from 'react'
import type { OpenMode, OpenRequest } from '../state/store'
import { useStore } from '../state/store'
import { paneTitle } from '../state/connect'
import ModalBackdrop from './ModalBackdrop'
import Hint from './Hint'
import { describeCredential } from './connectMenu'
import { useT } from '../i18n'

/**
 * The most windows one press may open.
 *
 * A cap rather than a warning, and low enough to be an obvious limit rather
 * than a surprise: every one of these is a real connection, a real shell on the
 * far end, and a real authentication attempt — a mistyped 300 against a host
 * that locks an account after five failures is a bad afternoon. Somebody who
 * genuinely wants forty presses the button twice.
 */
const MOST = 20

/**
 * Opening one host several times over.
 *
 * The case is a working one rather than a curiosity: watching a log in one
 * window while running something in another, or a job per window on a machine
 * that has the cores for it. Doing it by hand means the same double-click and
 * the same wait, over and over, and it is the sort of thing that quietly gets
 * done four times instead of the six that were wanted.
 *
 * The account belongs here for the same reason it belongs in the menu above:
 * having chosen to open six windows, "and all of them as the administrator" is
 * the next thing asked, and sending someone back to a different menu to say it
 * would mean opening six and closing six.
 */
export default function MultiConnectDialog({
  host,
  onClose
}: {
  host: { id: string; name: string; color?: string }
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const credentials = useStore((s) => s.credentials)
  const openMany = useStore((s) => s.openMany)

  const [count, setCount] = useState(2)
  const [credentialId, setCredentialId] = useState('')
  const [mode, setMode] = useState<OpenMode>('tabs')

  const credential = credentials.find((c) => c.id === credentialId)

  function connect(): void {
    // Clamped here as well as on the input: a number box can be typed into and
    // still hold something out of range when the button is pressed.
    const wanted = Math.min(MOST, Math.max(1, Math.round(count)))
    const items: OpenRequest[] = []
    for (let n = 1; n <= wanted; n++) {
      items.push({
        // Numbered, because the point of six windows is telling them apart.
        title: paneTitle(host.name, credential, wanted > 1 ? n : undefined),
        target: { kind: 'session', sessionId: host.id, credentialId: credentialId || undefined },
        color: host.color
      })
    }
    openMany(items, mode, host.name)
    onClose()
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>{t('Connect several times')}</h2>
        <p className="settings-note">{host.name}</p>

        <div className="form-row">
          <label>
            <Hint label={t('How many')}>
              {t(
                'Each window is a connection of its own, so the host sees as many sessions as you ask for.'
              )}
            </Hint>
            <input
              autoFocus
              type="number"
              min={1}
              max={MOST}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && connect()}
            />
          </label>
          <label style={{ flex: 1 }}>
            <Hint label={t('Account')}>
              {t(
                'Applies to these windows only. The host keeps the login it is saved with, and every other connection to it is unaffected.'
              )}
            </Hint>
            <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
              <option value="">{t('Its own saved login')}</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {describeCredential(c)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label>
          {t('Open them')}
          <select value={mode} onChange={(e) => setMode(e.target.value as OpenMode)}>
            <option value="tabs">{t('As separate tabs here')}</option>
            <option value="grid">{t('Tiled into one tab')}</option>
            <option value="workspace">{t('In a workspace of their own')}</option>
          </select>
        </label>

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={connect}>
            {t('Connect')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
