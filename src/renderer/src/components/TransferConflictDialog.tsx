import { useState } from 'react'
import type { TransferDecisions, TransferPlan } from '../../../shared/types'
import { defaultDecisions, isRefusable } from '../../../shared/transferPlan'
import { formatSize } from '../../../shared/fileSize'
import ModalBackdrop from './ModalBackdrop'
import { useT, type Translate } from '../i18n'

/** Outside the component, so the phrase book is handed in rather than hooked. */
function when(t: Translate, ms: number): string {
  if (!ms) return t('unknown')
  return new Date(ms).toLocaleString()
}

/**
 * Why a clash is refused outright rather than offered as a choice.
 *
 * Literal phrases in a function rather than a table looked up by key: the
 * phrase book's coverage test reads the source for `t('…')`, and a key
 * assembled at runtime is invisible to it.
 */
function refusedBecause(t: Translate, reason: string): string {
  if (reason === 'directory') return t('a folder is already there — cannot be replaced by a file')
  if (reason === 'symlink') return t('a symlink is already there — not written through')
  return t('could not be read, so it is left alone')
}

/** The heading, whole, per direction — see the note on counted phrases. */
function heading(t: Translate, direction: TransferPlan['direction'], count: number): string {
  if (direction === 'upload') return t('Uploading over {count} existing files', { count })
  if (direction === 'download') return t('Downloading over {count} existing files', { count })
  return t('Copying over {count} existing files', { count })
}

interface Props {
  plan: TransferPlan
  /** Opens a line-by-line comparison for one clashing file. */
  onCompare: (remotePath: string, localPath: string) => void
  onCancel: () => void
  onConfirm: (decisions: TransferDecisions) => void
}

/**
 * Asks about every clash before anything moves.
 *
 * Everything starts on Skip. The default of a dialog that can destroy files
 * should be the harmless one, so that dismissing it in a hurry costs a repeat
 * rather than a file nobody has a copy of.
 */
export default function TransferConflictDialog({
  plan,
  onCompare,
  onCancel,
  onConfirm
}: Props): JSX.Element {
  const t = useT()
  const [decisions, setDecisions] = useState<TransferDecisions>(() => defaultDecisions(plan))

  const replaceable = plan.conflicts.filter((c) => !isRefusable(c.reason))
  const refused = plan.conflicts.filter((c) => isRefusable(c.reason))
  const overwriting = replaceable.filter((c) => decisions[c.destPath] === 'overwrite').length
  const untouched = plan.items.length - plan.conflicts.length
  // Comparing means reading both sides, and the differ only knows how to fetch
  // one remote file and one local one. Host to host has no local side to offer.
  const canCompare = plan.direction !== 'relay'

  function decide(destPath: string, choice: 'overwrite' | 'skip'): void {
    setDecisions((prev) => ({ ...prev, [destPath]: choice }))
  }

  function decideAll(choice: 'overwrite' | 'skip'): void {
    setDecisions((prev) => {
      const next = { ...prev }
      for (const c of replaceable) next[c.destPath] = choice
      return next
    })
  }

  // Two sources landing on one destination cannot be resolved by choosing, only
  // by not doing it: whichever ran last would win and the other vanish.
  if (plan.collisions.length > 0) {
    return (
      <ModalBackdrop onClose={onCancel}>
        <div className="modal-card">
          <h2>{t('This transfer would overwrite itself')}</h2>
          <p className="settings-note">
            {t(
              'Two files in the batch land on the same destination. That normally means the local filesystem treats names as case-insensitive while the remote one does not. Whichever copied last would win and the other would be gone, so nothing is transferred.'
            )}
          </p>
          <div className="conflict-list">
            {plan.collisions.map((c) => (
              <div className="conflict-row" key={c.destPath}>
                <div className="conflict-main">
                  <span className="conflict-path">{c.destPath}</span>
                  <span className="conflict-detail">{c.sourcePaths.join('  ·  ')}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="modal-actions">
            <button className="primary" onClick={onCancel}>
              {t('Close')}
            </button>
          </div>
        </div>
      </ModalBackdrop>
    )
  }

  return (
    <ModalBackdrop onClose={onCancel}>
      <div className="modal-card conflict-card">
        <h2>{heading(t, plan.direction, plan.conflicts.length)}</h2>
        <p className="settings-note">
          {untouched > 0
            ? t('Other files written as normal: {count}. ', { count: untouched })
            : ''}
          {t('Nothing is overwritten unless you say so here, and nothing is remembered for next time.')}
        </p>

        {replaceable.length > 0 && (
          <>
            <div className="conflict-bulk">
              <button onClick={() => decideAll('skip')}>{t('Skip all')}</button>
              <button onClick={() => decideAll('overwrite')}>{t('Overwrite all')}</button>
            </div>
            <div className="conflict-list">
              {replaceable.map((c) => {
                const choice = decisions[c.destPath] ?? 'skip'
                return (
                  <div className="conflict-row" key={c.destPath}>
                    <div className="conflict-main">
                      <span className="conflict-path" title={c.destPath}>
                        {c.destPath}
                      </span>
                      <span className="conflict-detail">
                        {t('new')} {formatSize(c.sourceSize)}, {when(t, c.sourceMtime)} →{' '}
                        {t('there now')} {formatSize(c.destSize)}, {when(t, c.destMtime)}
                      </span>
                    </div>
                    <div className="conflict-choice">
                      {canCompare && (
                        <button
                          title={t('See what is different before deciding')}
                          onClick={() =>
                            onCompare(
                              plan.direction === 'upload' ? c.destPath : c.sourcePath,
                              plan.direction === 'upload' ? c.sourcePath : c.destPath
                            )
                          }
                        >
                          {t('Compare')}
                        </button>
                      )}
                      <button
                        className={choice === 'skip' ? 'active' : ''}
                        onClick={() => decide(c.destPath, 'skip')}
                      >
                        {t('Skip')}
                      </button>
                      <button
                        className={choice === 'overwrite' ? 'active danger' : ''}
                        onClick={() => decide(c.destPath, 'overwrite')}
                      >
                        {t('Overwrite')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {refused.length > 0 && (
          <>
            <h3 className="settings-heading">{t('Skipped either way')}</h3>
            <div className="conflict-list">
              {refused.map((c) => (
                <div className="conflict-row" key={c.destPath}>
                  <div className="conflict-main">
                    <span className="conflict-path" title={c.destPath}>
                      {c.destPath}
                    </span>
                    <span className="conflict-detail">{refusedBecause(t, c.reason)}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>{t('Cancel')}</button>
          <button className="primary" onClick={() => onConfirm(decisions)}>
            {overwriting > 0
              ? t('Transfer, replacing {count}', { count: overwriting })
              : t('Transfer, skipping all {count}', { count: plan.conflicts.length })}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
