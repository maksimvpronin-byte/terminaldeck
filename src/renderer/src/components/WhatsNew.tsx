import { useState } from 'react'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import {
  markSeen,
  notesFor,
  notesStartAfter,
  parseBlocks,
  type Inline,
  type Release
} from '../whatsNew'

function Text({ parts }: { parts: Inline[] }): JSX.Element {
  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'bold' ? (
          <b key={i}>{p.text}</b>
        ) : p.kind === 'code' ? (
          <code key={i}>{p.text}</code>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </>
  )
}

/** The notes of one or more releases, newest first. */
export function WhatsNewDialog({
  releases,
  onClose
}: {
  releases: Release[]
  onClose: () => void
}): JSX.Element {
  const t = useT()
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal-card help-card whats-new-card">
        <h2>{t('What’s new')}</h2>
        {releases.length === 0 && <p className="settings-note">{t('No release notes.')}</p>}
        {releases.map((release) => (
          <section key={release.version}>
            <h3 className="whats-new-version">{release.version}</h3>
            {parseBlocks(release.body).map((block, i) =>
              block.kind === 'heading' ? (
                <h4 key={i} className="settings-heading">
                  <Text parts={block.text} />
                </h4>
              ) : block.kind === 'item' ? (
                <p key={i} className="whats-new-item" style={{ marginLeft: block.depth * 16 }}>
                  <Text parts={block.text} />
                </p>
              ) : (
                <p key={i}>
                  <Text parts={block.text} />
                </p>
              )
            )}
          </section>
        ))}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            {t('Done')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}

/**
 * Once, after the app has updated itself: which version this is now, and a
 * way to read what came with it. Closing the plate or the notes counts as
 * read; the next time it speaks is the next update.
 */
export default function WhatsNewBanner(): JSX.Element | null {
  const t = useT()
  const language = useStore((s) => s.settings.language)
  const current = window.td.appVersion
  // Asked once, as the window opens. A first install is marked read at once,
  // so that its first update has a version to start after.
  const [from] = useState(() => {
    const start = notesStartAfter(current)
    if (start === null) markSeen(current)
    return start
  })
  const [dismissed, setDismissed] = useState(false)
  const [reading, setReading] = useState(false)

  if (from === null || dismissed) return null
  const releases = notesFor(language, from, current)
  if (releases.length === 0) return null

  function close(): void {
    markSeen(current)
    setReading(false)
    setDismissed(true)
  }

  return (
    <>
      <div className="update-banner whats-new-banner">
        <span>{t('Updated to {version}.', { version: current })}</span>
        <span className="banner-actions">
          <button className="primary" onClick={() => setReading(true)}>
            {t('What’s new')}
          </button>
          <button onClick={close} title={t('Close')} aria-label={t('Close')}>
            ✕
          </button>
        </span>
      </div>
      {reading && <WhatsNewDialog releases={releases} onClose={close} />}
    </>
  )
}
