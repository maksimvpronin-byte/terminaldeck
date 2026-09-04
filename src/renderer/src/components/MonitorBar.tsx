import { useEffect, useRef, useState } from 'react'
import {
  formatMemory,
  formatRate,
  formatUptime,
  type RemoteStats
} from '../../../shared/remoteStats'
import { useT } from '../i18n'

/** How many readings the load graph keeps. */
const HISTORY = 40

/**
 * A strip of live figures for the host this pane is connected to.
 *
 * Every field is drawn only when the host actually answered for it: a machine
 * without `/proc` shows fewer boxes rather than a row of zeroes, which would
 * read as an idle server rather than an unanswered question.
 */
export default function MonitorBar({
  connectionId
}: {
  connectionId?: string
}): JSX.Element | null {
  const t = useT()
  const [stats, setStats] = useState<RemoteStats | null>(null)
  const [stopped, setStopped] = useState(false)
  const history = useRef<number[]>([])

  useEffect(() => {
    if (!connectionId) return
    setStopped(false)
    history.current = []
    window.td.monitor.start(connectionId)
    const off = window.td.monitor.onStats(connectionId, (next) => {
      if (!next) {
        setStopped(true)
        return
      }
      if (next.cpuPercent !== undefined) {
        history.current = [...history.current, next.cpuPercent].slice(-HISTORY)
      }
      setStats(next)
    })
    return () => {
      off()
      window.td.monitor.stop(connectionId)
    }
  }, [connectionId])

  if (!connectionId) return null
  if (stopped) {
    return (
      <div className="monitor-bar">
        <span className="cell dim">{t('Monitoring stopped — the host stopped answering')}</span>
      </div>
    )
  }
  if (!stats) {
    return (
      <div className="monitor-bar">
        <span className="cell dim">{t('Reading…')}</span>
      </div>
    )
  }

  const load = history.current
  return (
    <div className="monitor-bar">
      {stats.user && (
        <span className="cell" title={t('Logged in as')}>
          👤 {stats.user}
        </span>
      )}
      {stats.cpuPercent !== undefined && (
        <span className="cell" title={t('Processor load')}>
          ⚙ {Math.round(stats.cpuPercent)}%
        </span>
      )}
      {load.length > 1 && (
        <span className="cell spark" title={t('Processor load over the last readings')}>
          {load.map((value, i) => (
            <i key={i} style={{ height: `${Math.max(2, Math.round(value))}%` }} />
          ))}
        </span>
      )}
      {stats.memUsedKb !== undefined && stats.memTotalKb !== undefined && (
        <span className="cell" title={t('Memory in use')}>
          ▦ {formatMemory(stats.memUsedKb, stats.memTotalKb)}
        </span>
      )}
      {stats.txPerSecond !== undefined && (
        <span className="cell" title={t('Sent by the host')}>
          ↑ {formatRate(stats.txPerSecond)}
        </span>
      )}
      {stats.rxPerSecond !== undefined && (
        <span className="cell" title={t('Received by the host')}>
          ↓ {formatRate(stats.rxPerSecond)}
        </span>
      )}
      {stats.uptimeSeconds !== undefined && (
        <span className="cell" title={t('Uptime')}>
          ⏱ {formatUptime(stats.uptimeSeconds)}
        </span>
      )}
      {stats.disks.map((disk) => (
        <span
          key={disk.mount}
          className={`cell ${disk.usedPercent >= 90 ? 'alarm' : disk.usedPercent >= 75 ? 'warn' : ''}`}
          title={t('{mount} is {percent}% full', { mount: disk.mount, percent: disk.usedPercent })}
        >
          {disk.mount}: {disk.usedPercent}%
        </span>
      ))}
    </div>
  )
}
