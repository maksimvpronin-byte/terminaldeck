import { useEffect, useMemo, useState } from 'react'
import type { FileComparison } from '../../../shared/types'
import { collapseUnchanged, diffLines } from '../../../shared/diff'
import ModalBackdrop from './ModalBackdrop'

/** Beyond this the view stops drawing: no one reads a 20,000-row diff. */
const MAX_ROWS = 4000

const BLOCKED: Record<string, string> = {
  binary: 'This is not a text file, so there is nothing to compare line by line.',
  'too-large': 'One of the two is past the 2 MB comparison limit.',
  missing: 'One of the two is no longer there.'
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
        <h2>Compare</h2>
        <p className="settings-note">
          <strong>−</strong> what is on the host now · <strong>+</strong> what would replace it
          <br />
          {remotePath} ↔ {localPath}
        </p>

        {error && <span className="error-text">{error}</span>}
        {!comparison && !error && <p className="settings-note">Reading both sides…</p>}

        {comparison?.blocked && (
          <p className="settings-note">{BLOCKED[comparison.blocked] ?? 'Cannot be compared.'}</p>
        )}

        {diff && diff.onlyLineEndings && (
          <p className="settings-note">
            The text is identical — only the line endings differ (CRLF against LF). Nothing else
            has changed.
          </p>
        )}

        {diff && !diff.onlyLineEndings && (
          <>
            <p className="settings-note">
              {diff.added} added, {diff.removed} removed
              {diff.coarse && ' — too large to align precisely, so it is shown as replaced'}
            </p>
            <div className="diff-view">
              {shown.map((row, i) =>
                row.kind === 'gap' ? (
                  <div className="diff-gap" key={`gap-${i}`}>
                    … {row.hidden} unchanged line{row.hidden === 1 ? '' : 's'}
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
                  … {rows.length - MAX_ROWS} more rows not drawn
                </div>
              )}
            </div>
          </>
        )}

        {diff && diff.added === 0 && diff.removed === 0 && !diff.onlyLineEndings && (
          <p className="settings-note">The two files are identical.</p>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
