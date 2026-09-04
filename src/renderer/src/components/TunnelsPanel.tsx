import { useCallback, useEffect, useState } from 'react'
import { nanoid } from 'nanoid'
import type { PortForwardRule } from '../../../shared/types'
import { useStore } from '../state/store'
import { useT } from '../i18n'

export function describeRule(rule: PortForwardRule): string {
  const src = `${rule.srcHost}:${rule.srcPort}`
  if (rule.type === 'dynamic') return `SOCKS on ${src}`
  if (rule.type === 'local') return `${src} → ${rule.dstHost}:${rule.dstPort}`
  return `remote ${src} → ${rule.dstHost}:${rule.dstPort}`
}

function blankRule(): PortForwardRule {
  return {
    id: nanoid(),
    type: 'local',
    srcHost: '127.0.0.1',
    srcPort: 8080,
    dstHost: '127.0.0.1',
    dstPort: 80
  }
}

interface Props {
  connectionId?: string
  sessionId?: string
}

export default function TunnelsPanel({ connectionId, sessionId }: Props): JSX.Element {
  const t = useT()
  const sessions = useStore((s) => s.sessions)
  const profile = sessionId ? sessions.find((s) => s.id === sessionId) : undefined

  const [activeIds, setActiveIds] = useState<string[]>([])
  const [adhoc, setAdhoc] = useState<PortForwardRule[]>([])
  const [draft, setDraft] = useState<PortForwardRule | null>(null)
  const [error, setError] = useState<string | null>(null)

  const rules = [...(profile?.portForwards ?? []), ...adhoc]

  const refresh = useCallback(async () => {
    if (!connectionId) {
      setActiveIds([])
      return
    }
    try {
      setActiveIds(await window.td.portForward.status(connectionId))
    } catch {
      /* connection went away */
    }
  }, [connectionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function toggle(rule: PortForwardRule): Promise<void> {
    if (!connectionId) return
    setError(null)
    try {
      if (activeIds.includes(rule.id)) {
        await window.td.portForward.stop(connectionId, rule.id)
      } else {
        await window.td.portForward.start(connectionId, rule)
      }
    } catch (err) {
      setError((err as Error).message)
    }
    refresh()
  }

  function addDraft(): void {
    if (!draft) return
    setAdhoc((list) => [...list, draft])
    setDraft(null)
  }

  return (
    <div className="side-panel">
      <div className="side-panel-title">{t('Tunnels')}</div>
      <div className="side-panel-list">
        {rules.length === 0 && (
          <div className="side-panel-empty">
            {t(
              'No forwarding rules. Rules saved on a session start automatically when it connects.'
            )}
          </div>
        )}
        {rules.map((r) => {
          const running = activeIds.includes(r.id)
          return (
            <div className="tunnel-row" key={r.id}>
              <span className={`tunnel-dot ${running ? 'on' : 'off'}`} />
              <span className="tunnel-label" title={describeRule(r)}>
                {describeRule(r)}
              </span>
              <button onClick={() => toggle(r)} disabled={!connectionId}>
                {running ? t('Stop') : t('Start')}
              </button>
            </div>
          )
        })}
      </div>

      {error && (
        <div className="error-text" style={{ padding: '4px 8px' }}>
          {error}
        </div>
      )}

      {draft ? (
        <div className="tunnel-draft">
          <select
            value={draft.type}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as PortForwardRule['type'] })
            }
          >
            <option value="local">{t('Local')}</option>
            <option value="remote">{t('Remote')}</option>
            <option value="dynamic">{t('Dynamic (SOCKS)')}</option>
          </select>
          <div className="form-row">
            <input
              value={draft.srcHost}
              onChange={(e) => setDraft({ ...draft, srcHost: e.target.value })}
              placeholder={t('bind host')}
            />
            <input
              type="number"
              value={draft.srcPort}
              onChange={(e) => setDraft({ ...draft, srcPort: Number(e.target.value) })}
              placeholder={t('port')}
            />
          </div>
          {draft.type !== 'dynamic' && (
            <div className="form-row">
              <input
                value={draft.dstHost ?? ''}
                onChange={(e) => setDraft({ ...draft, dstHost: e.target.value })}
                placeholder={t('target host')}
              />
              <input
                type="number"
                value={draft.dstPort ?? 0}
                onChange={(e) => setDraft({ ...draft, dstPort: Number(e.target.value) })}
                placeholder={t('port')}
              />
            </div>
          )}
          <div className="modal-actions">
            <button onClick={() => setDraft(null)}>{t('Cancel')}</button>
            <button className="primary" onClick={addDraft}>
              {t('Add')}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: 6, borderTop: '1px solid var(--border)' }}>
          <button style={{ width: '100%' }} onClick={() => setDraft(blankRule())}>
            + {t('Ad-hoc tunnel')}
          </button>
        </div>
      )}
    </div>
  )
}
