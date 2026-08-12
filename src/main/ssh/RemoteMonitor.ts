import type { BrowserWindow } from 'electron'
import { sshManager } from './SSHManager'
import { IPC } from '../../shared/ipc-channels'
import {
  diffSamples,
  parseProbe,
  probeCommand,
  type RemoteSample,
  type RemoteStats
} from '../../shared/remoteStats'

const INTERVAL_MS = 3000

interface Watch {
  timer: NodeJS.Timeout
  previous?: RemoteSample
  /** Set while a probe is in flight, so a slow host is not asked twice over. */
  busy: boolean
  failures: number
}

/**
 * Polls a connected host for the figures the monitoring strip draws.
 *
 * One watch per connection, started only while a strip is open: a host nobody
 * is looking at is left alone. Each tick is a single command on its own exec
 * channel, so nothing reaches the user's shell.
 */
class RemoteMonitor {
  private watches = new Map<string, Watch>()

  start(win: BrowserWindow, connectionId: string): void {
    if (this.watches.has(connectionId)) return
    const watch: Watch = {
      timer: setInterval(() => this.tick(win, connectionId), INTERVAL_MS),
      busy: false,
      failures: 0
    }
    this.watches.set(connectionId, watch)
    // The first reading has no rates in it, but the standing values — memory,
    // disks, uptime — are worth showing straight away rather than in three
    // seconds' time.
    this.tick(win, connectionId)
  }

  stop(connectionId: string): void {
    const watch = this.watches.get(connectionId)
    if (!watch) return
    clearInterval(watch.timer)
    this.watches.delete(connectionId)
  }

  stopAll(): void {
    for (const id of [...this.watches.keys()]) this.stop(id)
  }

  private async tick(win: BrowserWindow, connectionId: string): Promise<void> {
    const watch = this.watches.get(connectionId)
    if (!watch || watch.busy) return
    watch.busy = true
    try {
      const output = await sshManager.exec(connectionId, probeCommand)
      const sample = parseProbe(output, Date.now())
      const stats = diffSamples(watch.previous, sample)
      watch.previous = sample
      watch.failures = 0
      this.publish(win, connectionId, stats)
    } catch {
      // One failed probe is a blip — a busy host, a dropped channel. Several
      // in a row means the connection is gone, and polling a dead host for
      // ever is worse than stopping and letting the user turn it back on.
      watch.failures += 1
      if (watch.failures >= 3) {
        this.stop(connectionId)
        this.publish(win, connectionId, null)
      }
    } finally {
      watch.busy = false
    }
  }

  private publish(win: BrowserWindow, connectionId: string, stats: RemoteStats | null): void {
    if (win.isDestroyed()) return
    win.webContents.send(`${IPC.monitorStats}:${connectionId}`, stats)
  }
}

export const remoteMonitor = new RemoteMonitor()
