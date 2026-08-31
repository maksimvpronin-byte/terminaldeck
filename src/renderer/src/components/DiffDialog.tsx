import { useEffect, useMemo, useState } from 'react'
import type { FileComparison } from '../../../shared/types'
import { collapseUnchanged, diffLines } from '../../../shared/diff'
import ModalBackdrop from './ModalBackdrop'
import { useT, type Translate } from '../i18n'

/** Beyond this the view stops drawing: no one reads a 20,000-row diff. */
const MAX_ROWS = 4000

/**
 * Why there is nothing to show, in words.
 *
 * A function of literal phrases rather than a table looked up by key: the
 * phrase book's coverage test reads the source for `t('…')`, and a key assembled
 * at runtime is invisible to it — which is how a phrase goes untranslated with
 * nothing to say so.
 */
function blockedBecause(t: Translate, reason: string): string {
  if (reason === 'binary') {
    return t('This is not a text file, so there is nothing to compare line by line.')
  }
  if (reason === 'too-large') return t('One of the two is past the 2 MB comparison limit.')
  if (reason === 'missing') return t('One of the two is no longer there.')
  return t('Cannot be compared.')
}

interface Props {
  connectionId: string
  remotePath: string
  localPath: string
  onClose: () => void
}

export default function DiffDialog({
  connectionId,
  remotePath,
  localPath,
  onClose
}: Props): JSX.Element {
  const t = useT()
  const [comparison, setComparison] = useState<FileComparison | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.td.sftp
      .compare(connectionId, remotePath, localPath)
      .then(setComparison)
      .catch((err: Error) => setError(err.message))
  }, [connectionId, remotePath, localPath])

  const diff = useMemo(() => {
    if (!comparison || comparison.local === null || comparison.remote === null) return null
    // Local on the left, remote on the right: an upload reads as "what I have"
    // becoming "what is there", which is the direction the decision is about.
    return diffLines(comparison.remote, comparison.local)
  }, [comparison])

  const rows = useMemo(() => (diff ? collapseUnchanged(diff.lines, 3) : []), [diff])
  const shown = rows.slice(0, MAX_ROWS)

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card diff-card">
        <h2>{t('Compare')}</h2>
        <p className="settings-note">
          <strong>−</strong> {t('what is on the host now')} · <strong>+</strong>{' '}
          {t('what would replace it')}
          <br />
          {remotePath} ↔ {localPath}
        </p>

        {error && <span className="error-text">{error}</span>}
        {!comparison && !error && <p className="settings-note">{t('Reading both sides…')}</p>}

        {comparison?.blocked && (
          <p className="settings-note">{blockedBecause(t, comparison.blocked)}</p>
        )}

        {diff && diff.onlyLineEndings && (
          <p className="settings-note">
            {t(
              'The text is identical — only the line endings differ (CRLF against LF). Nothing else has changed.'
            )}
          </p>
        )}

        {diff && !diff.onlyLineEndings && (
          <>
            <p className="settings-note">
              {t('added: {added}, removed: {removed}', {
                added: diff.added,
                removed: diff.removed
              })}
              {diff.coarse && t(' — too large to align precisely, so it is shown as replaced')}
            </p>
            <div className="diff-view">
              {shown.map((row, i) =>
                row.kind === 'gap' ? (
                  <div className="diff-gap" key={`gap-${i}`}>
                    … {t('unchanged lines: {count}', { count: row.hidden })}
                  </div>
                ) : (
                  <div className={`diff-line ${row.line.kind}`} key={`l-${i}`}>
                    <span className="diff-no">
                      {row.line.kind === 'added' ? '' : row.line.leftNo}
                    </span>
                    <span className="diff-no">
                      {row.line.kind === 'removed' ? '' : row.line.rightNo}
                    </span>
                    <span className="diff-sign">
                      {row.line.kind === 'added' ? '+' : row.line.kind === 'removed' ? '−' : ' '}
                    </span>
                    <span className="diff-text">{row.line.text || ' '}</span>
                  </div>
                )
              )}
              {rows.length > MAX_ROWS && (
                <div className="diff-gap">
                  … {t('{count} more rows not drawn', { count: rows.length - MAX_ROWS })}
                </div>
              )}
            </div>
          </>
        )}

        {diff && diff.added === 0 && diff.removed === 0 && !diff.onlyLineEndings && (
          <p className="settings-note">{t('The two files are identical.')}</p>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
