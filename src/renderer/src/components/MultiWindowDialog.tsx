import { useState } from 'react'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import ModalBackdrop from './ModalBackdrop'

/**
 * Names a multi-window: a tab being kept for the first time, or one already
 * kept being renamed. A name already in use is said so, and saving keeps the
 * tab in place of that one rather than beside it — saving the same tab twice
 * used to be how two identical entries came about in collections.
 */
export default function MultiWindowDialog({
  tabId,
  renaming,
  defaultName,
  onClose
}: {
  /** The tab whose panes are kept; absent when only renaming. */
  tabId?: string
  /** The multi-window being renamed. */
  renaming?: string
  defaultName: string
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const multiWindows = useStore((s) => s.multiWindows)
  const saveTabAsMultiWindow = useStore((s) => s.saveTabAsMultiWindow)
  const renameMultiWindow = useStore((s) => s.renameMultiWindow)
  const [name, setName] = useState(defaultName)
  const [error, setError] = useState('')
  const clash = multiWindows.find(
    (w) => w.id !== renaming && w.name.trim().toLowerCase() === name.trim().toLowerCase()
  )

  async function submit(): Promise<void> {
    if (!name.trim()) return
    try {
      if (renaming) {
        await renameMultiWindow(renaming, name)
      } else if (tabId) {
        const kept = await saveTabAsMultiWindow(tabId, name, clash?.id)
        if (!kept) {
          setError(t('This tab has no saved host to keep — Quick connect panes are not kept.'))
          return
        }
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{renaming ? t('Rename multi-window') : t('Save as multi-window')}</h2>
        {!renaming && (
          <p className="settings-note">
            {t(
              'The tab’s panes are kept as they stand — which hosts, split which way, how large — and open again in one go, as a new tab. Only references are kept: no passwords, and nothing that is connected now.'
            )}
          </p>
        )}
        <label>
          {t('Name')}
          <input
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </label>
        {clash && !renaming && (
          <p className="settings-note">
            {t('“{name}” already exists; saving puts this tab in its place.', { name: clash.name })}
          </p>
        )}
        {clash && renaming && (
          <p className="settings-note">{t('Another multi-window has this name.')}</p>
        )}
        {error && <span className="error-text">{error}</span>}
        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={!name.trim() || Boolean(renaming && clash)}
          >
            {clash && !renaming ? t('Replace') : t('Save')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
