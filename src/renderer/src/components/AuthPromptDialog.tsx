import { useEffect, useState } from 'react'
import type { AuthPromptRequest } from '../../../shared/types'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

/**
 * Serves credential requests raised by the SSH layer mid-handshake: a password
 * that isn't in the vault, or a keyboard-interactive challenge such as a 2FA code.
 *
 * Questions queue, and are answered in the order they were asked. This held one
 * at a time and a new one replaced whatever was showing: open a group of hosts
 * with no saved password and every question but the last vanished unanswered,
 * each leaving its connection — and any jump host it had already signed in to —
 * waiting on a reply that could no longer be given.
 */
export default function AuthPromptDialog(): JSX.Element | null {
  const t = useT()
  const [queue, setQueue] = useState<AuthPromptRequest[]>([])
  const [answers, setAnswers] = useState<string[]>([])
  const request = queue[0] ?? null

  useEffect(() => {
    const offPrompt = window.td.auth.onPrompt((req) => {
      setQueue((prev) => (prev.some((r) => r.requestId === req.requestId) ? prev : [...prev, req]))
    })
    // Withdrawn by the main process: the connection it was for has gone.
    const offCancel = window.td.auth.onCancel((requestId) => {
      setQueue((prev) => prev.filter((r) => r.requestId !== requestId))
    })
    return () => {
      offPrompt()
      offCancel()
    }
  }, [])

  // Fresh, empty fields for each question as it reaches the front.
  const requestId = request?.requestId
  const fieldCount = request?.fields.length ?? 0
  useEffect(() => {
    setAnswers(Array.from({ length: fieldCount }, () => ''))
  }, [requestId, fieldCount])

  if (!request) return null
  const current = request

  function respond(values: string[] | null): void {
    window.td.auth.reply(current.requestId, values)
    setQueue((prev) => prev.filter((r) => r.requestId !== current.requestId))
  }

  return (
    <ModalBackdrop onClose={() => respond(null)}>
      <div className="modal-card" style={{ width: 400 }}>
        <h2>{current.title}</h2>
        <p className="settings-note">{current.host}</p>
        {current.instructions && <p className="settings-note">{current.instructions}</p>}

        {current.fields.map((field, i) => (
          <label key={`${current.requestId}-${field.prompt}-${i}`}>
            {field.prompt}
            <input
              autoFocus={i === 0}
              type={field.echo ? 'text' : 'password'}
              value={answers[i] ?? ''}
              onChange={(e) =>
                setAnswers((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))
              }
              onKeyDown={(e) => {
                // Enter submits from the last field only, so multi-prompt
                // challenges aren't sent half-filled.
                if (e.key === 'Enter' && i === current.fields.length - 1) respond(answers)
                if (e.key === 'Escape') respond(null)
              }}
            />
          </label>
        ))}

        {queue.length > 1 && (
          <p className="settings-note">
            {t('{count} more waiting', { count: String(queue.length - 1) })}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={() => respond(null)}>{t('Cancel')}</button>
          <button className="primary" onClick={() => respond(answers)}>
            {t('Continue')}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  )
}
