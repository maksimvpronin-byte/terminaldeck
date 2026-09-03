import { useState } from 'react'
import type { GitFolderPreview } from '../../../shared/types'
import { descendantPaths } from '../../../shared/gitFolders'
import { useStore } from '../state/store'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

/**
 * What a sync found, and which of it to take.
 *
 * Shown on every sync rather than only when something is new, because this is
 * also where a sync says what it is about to take away: a group that has left
 * the repository, and the hosts that go with it. Nothing on disk has changed by
 * the time this appears — closing it leaves the folder exactly as it was.
 */
export default function GitFolderSyncDialog({
  folderName,
  preview,
  onClose
}: {
  folderName: string
  preview: GitFolderPreview
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const applyGitFolder = useStore((s) => s.applyGitFolder)
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(preview.included))
  const [busy, setBusy] = useState(false)

  const allPaths = preview.groups.map((g) => g.path)

  /** A group carries its subgroups, both when ticked and when unticked. */
  function toggle(path: string): void {
    setChosen((prev) => {
      const next = new Set(prev)
      const branch = descendantPaths(path, allPaths)
      if (prev.has(path)) for (const p of branch) next.delete(p)
      else for (const p of branch) next.add(p)
      return next
    })
  }

  async function apply(): Promise<void> {
    setBusy(true)
    await applyGitFolder(preview.groupId, [...chosen])
    setBusy(false)
    onClose()
  }

  const newCount = preview.groups.filter((g) => g.isNew).length
  const losingSettings = preview.removedHosts.filter((h) => h.hasLocalSettings)

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card">
        <h2>{t('Groups to take from the repository')}</h2>
        <p className="settings-note">
          {t(
            'Ticking a group takes its subgroups too. Only what is ticked appears in “{folder}” — anything untied here is left in the repository, not deleted from it.',
            { folder: folderName }
          )}
        </p>

        {preview.warning && <span className="error-text">{preview.warning}</span>}

        {preview.groups.length === 0 ? (
          <p className="settings-note">{t('This repository holds no groups.')}</p>
        ) : (
          <>
            <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
              <button onClick={() => setChosen(new Set(allPaths))}>{t('Select all')}</button>
              <button onClick={() => setChosen(new Set())}>{t('Select none')}</button>
              {newCount > 0 && (
                <span className="settings-note" style={{ margin: 0 }}>
                  {t('{count} new since the last sync', { count: newCount })}
                </span>
              )}
            </div>

            <div className="sync-group-list">
              {preview.groups.map((group) => (
                <label
                  key={group.path}
                  className="checkbox-row"
                  style={{
                    flexDirection: 'row',
                    paddingLeft: group.path.split('/').length * 12 - 12
                  }}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(group.path)}
                    onChange={() => toggle(group.path)}
                  />
                  <span className="name">{group.name}</span>
                  {group.hostCount > 0 && <span className="child-count">{group.hostCount}</span>}
                  {group.isNew && <span className="badge-new">{t('new')}</span>}
                </label>
              ))}
            </div>
          </>
        )}

        {preview.removedGroups.length > 0 && (
          <p className="settings-note">
            {t('Gone from the repository, and about to go from this folder: {groups}', {
              groups: preview.removedGroups.join(', ')
            })}
          </p>
        )}

        {preview.removedHosts.length > 0 && (
          <p className="settings-note">
            {t('{count} hosts will disappear from this folder: {hosts}', {
              count: preview.removedHosts.length,
              hosts: preview.removedHosts
                .slice(0, 12)
                .map((h) => h.name)
                .join(', ')
            })}
          </p>
        )}

        {losingSettings.length > 0 && (
          <p className="settings-note">
            {t(
              '{count} of them have local settings, which go with them — including any password saved for them here.',
              { count: losingSettings.length }
            )}
          </p>
        )}

        <p className="settings-note">
          {preview.revision
            ? t('Revision {revision}, {count} inventory files read', {
                revision: preview.revision,
                count: preview.files.length
              })
            : t('{count} inventory files read', { count: preview.files.length })}
        </p>

        <div className="modal-actions">
          <button onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" onClick={apply} disabled={busy}>
            {busy ? t('Applying…') : t('Apply')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
