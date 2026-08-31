import { useEffect, useState } from 'react'
import type { AuthPromptRequest } from '../../../shared/types'
import ModalBackdrop from './ModalBackdrop'
import { useT } from '../i18n'

/**
 * Serves credential requests raised by the SSH layer mid-handshake: a password
 * that isn't in the vault, or a keyboard-interactive challenge such as a 2FA code.
 */
export default function AuthPromptDialog(): JSX.Element | null {
  const t = useT()
  const [request, setRequest] = useState<AuthPromptRequest | null>(null)
  const [answers, setAnswers] = useState<string[]>([])

  useEffect(() => {
    return window.td.auth.onPrompt((req) => {
      setRequest(req)
      setAnswers(req.fields.map(() => ''))
    })
  }, [])

  if (!request) return null

  function respond(values: string[] | null): void {
    if (!request) return
    window.td.auth.reply(request.requestId, values)
    setRequest(null)
    setAnswers([])
  }

  return (
    <ModalBackdrop onClose={() => respond(null)}>
      <div className="modal-card" style={{ width: 400 }}>
        <h2>{request.title}</h2>
        <p className="settings-note">{request.host}</p>
        {request.instructions && <p className="settings-note">{request.instructions}</p>}

        {request.fields.map((field, i) => (
          <label key={`${field.prompt}-${i}`}>
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
                if (e.key === 'Enter' && i === request.fields.length - 1) respond(answers)
                if (e.key === 'Escape') respond(null)
              }}
            />
          </label>
        ))}

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
