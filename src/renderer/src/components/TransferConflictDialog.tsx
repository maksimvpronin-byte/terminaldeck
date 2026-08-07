import { useState } from 'react'
import type { TransferDecisions, TransferPlan } from '../../../shared/types'
import { defaultDecisions, isRefusable } from '../../../shared/transferPlan'
import ModalBackdrop from './ModalBackdrop'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}

function when(ms: number): string {
  if (!ms) return 'unknown'
  return new Date(ms).toLocaleString()
}

const REFUSAL: Record<string, string> = {
  directory: 'a folder is already there — cannot be replaced by a file',
  symlink: 'a symlink is already there — not written through',
  unreadable: 'could not be read, so it is left alone'
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
  const [decisions, setDecisions] = useState<TransferDecisions>(() => defaultDecisions(plan))

  const replaceable = plan.conflicts.filter((c) => !isRefusable(c.reason))
  const refused = plan.conflicts.filter((c) => isRefusable(c.reason))
  const overwriting = replaceable.filter((c) => decisions[c.destPath] === 'overwrite').length
  const untouched = plan.items.length - plan.conflicts.length
  const direction = plan.direction === 'upload' ? 'Uploading' : 'Downloading'

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
          <h2>This transfer would overwrite itself</h2>
          <p className="settings-note">
            Two files in the batch land on the same destination. That normally means the local
            filesystem treats names as case-insensitive while the remote one does not. Whichever
            copied last would win and the other would be gone, so nothing is transferred.
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
              Close
            </button>
          </div>
        </div>
      </ModalBackdrop>
    )
  }

  return (
    <ModalBackdrop onClose={onCancel}>
      <div className="modal-card conflict-card">
        <h2>
          {direction} over {plan.conflicts.length} existing file
          {plan.conflicts.length === 1 ? '' : 's'}
        </h2>
        <p className="settings-note">
          {untouched > 0
            ? `${untouched} other file${untouched === 1 ? '' : 's'} will be written as normal. `
            : ''}
          Nothing is overwritten unless you say so here, and nothing is remembered for next time.
        </p>

        {replaceable.length > 0 && (
          <>
            <div className="conflict-bulk">
              <button onClick={() => decideAll('skip')}>Skip all</button>
              <button onClick={() => decideAll('overwrite')}>Overwrite all</button>
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
                        new {formatSize(c.sourceSize)}, {when(c.sourceMtime)} → there now{' '}
                        {formatSize(c.destSize)}, {when(c.destMtime)}
                      </span>
                    </div>
                    <div className="conflict-choice">
                      <button
                        title="See what is different before deciding"
                        onClick={() =>
                          onCompare(
                            plan.direction === 'upload' ? c.destPath : c.sourcePath,
                            plan.direction === 'upload' ? c.sourcePath : c.destPath
                          )
                        }
                      >
                        Compare
                      </button>
                      <button
                        className={choice === 'skip' ? 'active' : ''}
                        onClick={() => decide(c.destPath, 'skip')}
                      >
                        Skip
                      </button>
                      <button
                        className={choice === 'overwrite' ? 'active danger' : ''}
                        onClick={() => decide(c.destPath, 'overwrite')}
                      >
                        Overwrite
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
            <h3 className="settings-heading">Skipped either way</h3>
            <div className="conflict-list">
              {refused.map((c) => (
                <div className="conflict-row" key={c.destPath}>
                  <div className="conflict-main">
                    <span className="conflict-path" title={c.destPath}>
                      {c.destPath}
                    </span>
                    <span className="conflict-detail">{REFUSAL[c.reason]}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onConfirm(decisions)}>
            {overwriting > 0
              ? `Transfer, replacing ${overwriting}`
              : `Transfer, skipping all ${plan.conflicts.length}`}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
