import { aiMessage } from './aiMessages'
import { useEffect, useState } from 'react'
import type { AiAnalysis } from '../../../shared/ai'
import { useStore } from '../state/store'
import { useT } from '../i18n'
import SettingsDialog from './SettingsDialog'

export default function AiPanel({
  connectionId,
  title,
  visible,
  onClose
}: {
  connectionId: string
  title: string
  visible: boolean
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const language = useStore((s) => s.settings.language)
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  useEffect(() => {
    let alive = true
    setAnalysis(null)
    setError('')
    setBusy(false)
    const accept = (next: AiAnalysis): void => {
      if (!alive || next.connectionId !== connectionId) return
      setAnalysis((old) =>
        old &&
        (old.startedAt > next.startedAt || (old.id === next.id && old.revision > next.revision))
          ? old
          : next
      )
    }
    const off = window.td.ai.onUpdate(accept)
    window.td.ai
      .get(connectionId)
      .then((next) => {
        if (next) accept(next)
      })
      .catch(() => {
        if (alive) setError('SSH connection is unavailable')
      })
    return () => {
      alive = false
      off()
    }
  }, [connectionId])
  async function act(action: 'start' | 'approve' | 'skip' | 'stop' | 'report'): Promise<void> {
    setBusy(true)
    setError('')
    try {
      if (action === 'start') await window.td.ai.start(connectionId, language)
      else if (action === 'stop') await window.td.ai.stop(connectionId)
      else if (analysis) {
        if (action === 'report') await window.td.ai.report(connectionId, analysis.id)
        else {
          const pending = analysis.steps.find((s) => s.status === 'pending')
          if (pending) await window.td.ai.decide(connectionId, analysis.id, pending.id, action)
        }
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const active = analysis && ['awaiting', 'running', 'thinking'].includes(analysis.status)
  const pending = analysis?.steps.find((s) => s.status === 'pending')
  return (
    <>
      <aside
        className="ai-panel"
        aria-label={t('AI assistant')}
        style={visible ? undefined : { display: 'none' }}
      >
        <header className="ai-header">
          <div>
            <strong>{t('AI assistant')}</strong>
            <div className="ai-host">{title}</div>
            {analysis && <div className="ai-host">{analysis.host}</div>}
          </div>
          <button aria-label={t('Hide AI assistant')} onClick={onClose}>
            ×
          </button>
        </header>
        <div className="ai-actions ai-toolbar">
          <button className="primary" disabled={busy || !!active} onClick={() => void act('start')}>
            {t('Analyze')}
          </button>
          <button disabled={!active} onClick={() => void act('stop')}>
            {t('Stop analysis')}
          </button>
          <button onClick={() => setSettingsOpen(true)}>{t('AI settings')}</button>
        </div>
        <div className="ai-content">
          {!analysis && (
            <div className="ai-empty">
              <h3>{t('Understand this Linux host')}</h3>
              <p>
                {t(
                  'Review CPU, memory, disks and services. Analyze prepares a plan; nothing runs until you approve each command.'
                )}
              </p>
              <p>
                {t(
                  'Disk checks cover capacity, inodes, latency, errors and RAID. SMART/NVMe checks can be proposed when a device is identified.'
                )}
              </p>
            </div>
          )}
          {error && (
            <p className="error-text" role="alert">
              {aiMessage(error, t)}
            </p>
          )}
          {analysis && (
            <>
              <div className="ai-progress" role="status">
                <strong>{aiMessage(analysis.status, t)}</strong> ·{' '}
                {analysis.steps.filter((s) => s.result).length}/{analysis.steps.length}{' '}
                {t('commands completed')}
                <br />
                {t('Started')}: {new Date(analysis.startedAt).toLocaleString()} ·{' '}
                {analysis.modelRequests} {t('AI requests')}
                <br />
                {analysis.model} · {analysis.provider}
              </div>
              {analysis.error && (
                <p className="error-text" role="alert">
                  {aiMessage(analysis.error, t)}
                </p>
              )}
              {analysis.explanation && <p className="ai-explanation">{analysis.explanation}</p>}
              {analysis.status === 'awaiting' && pending && (
                <section className="ai-proposal" key={pending.id}>
                  <h3>{pending.title}</h3>
                  <p>{pending.reason}</p>
                  <div className="ai-host">{analysis.host}</div>
                  <pre>{pending.command}</pre>
                  <p>{pending.rights}</p>
                  <p>{pending.impact}</p>
                  <p className="settings-note">
                    {t(
                      'Only this exact command will run once on this connection. Filtered output will be sent to the configured AI provider.'
                    )}
                  </p>
                  <div className="ai-actions">
                    <button className="primary" disabled={busy} onClick={() => void act('approve')}>
                      {t('Run this command')}
                    </button>
                    <button disabled={busy} onClick={() => void act('skip')}>
                      {t('Skip command')}
                    </button>
                  </div>
                </section>
              )}
              {analysis.status === 'awaiting' && (
                <button disabled={busy} onClick={() => void act('report')}>
                  {t('Finish with collected data (skip remaining checks)')}
                </button>
              )}
              <h3>{t('Diagnostic sequence and results')}</h3>
              <ol className="ai-sequence">
                {analysis.steps.map((step, index) => (
                  <li key={step.id} id={`ai-step-${step.id}`}>
                    <details open={step.status === 'running'}>
                      <summary>
                        <span>
                          {index + 1}. {step.title}
                        </span>
                        <small>{aiMessage(step.status, t)}</small>
                      </summary>
                      <p>{step.reason}</p>
                      <pre>{step.command}</pre>
                      {step.approvedAt && (
                        <p>
                          {t('Approved at')}: {new Date(step.approvedAt).toLocaleTimeString()}
                        </p>
                      )}
                      {step.result && (
                        <>
                          <p>
                            {aiMessage(step.result.outcome, t)} · {step.result.durationMs} ms ·{' '}
                            {t('Exit code')}: {step.result.exitCode ?? '—'} {step.result.signal}
                          </p>
                          <pre>{step.result.stdout || t('No stdout')}</pre>
                          {step.result.stderr && (
                            <pre className="error-text">{step.result.stderr}</pre>
                          )}
                          {step.result.truncated && (
                            <p>{t('Output was truncated; this check is incomplete.')}</p>
                          )}
                        </>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
              {analysis.report && (
                <section className="ai-report">
                  <h3>{t('Machine health report')}</h3>
                  <p>{analysis.report.summary}</p>
                  {analysis.report.findings.map((finding, i) => (
                    <article className={`ai-finding ${finding.severity}`} key={i}>
                      <strong>
                        {aiMessage(finding.severity, t)} — {finding.observation}
                      </strong>
                      <p>
                        <b>{t('Possible cause')}: </b>
                        {finding.hypothesis}
                      </p>
                      <p>
                        <b>{t('Recommendation')}: </b>
                        {finding.recommendation}
                      </p>
                      <div className="ai-actions">
                        {finding.evidence.map((id) => (
                          <button
                            key={id}
                            onClick={() => {
                              const el = document.getElementById(`ai-step-${id}`)
                              const details = el?.querySelector('details')
                              if (details) details.open = true
                              el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
                            }}
                          >
                            {t('Evidence')} {analysis.steps.findIndex((s) => s.id === id) + 1}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                  <h4>{t('Limitations')}</h4>
                  <ul>
                    {analysis.report.limitations.map((text, i) => (
                      <li key={i}>{text}</li>
                    ))}
                  </ul>
                </section>
              )}
              <p className="settings-note">
                {t(
                  'Results stay in memory for this SSH session. Closing the panel hides it; Stop, vault lock or disconnect cancels active work. AI interpretations need administrator review.'
                )}
              </p>
            </>
          )}
        </div>
      </aside>
      {settingsOpen && visible && (
        <SettingsDialog initialTab="ai" onClose={() => setSettingsOpen(false)} />
      )}
    </>
  )
}
