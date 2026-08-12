/**
 * What the monitoring strip shows, and how it is read off the far end.
 *
 * Everything comes from one command per tick, so a host is asked once rather
 * than six times. Rates — processor load, network throughput — are differences
 * between two ticks, because `/proc` counters are totals since boot and say
 * nothing on their own.
 *
 * The probe reads `/proc`, which is Linux. Elsewhere the sections come back
 * empty and their fields stay undefined; the strip then draws what it has
 * rather than zeroes, since "unknown" and "nothing is happening" are not the
 * same thing.
 */

/** Marks each section so one round trip carries all of them. */
const PROBE_COMMAND = [
  'echo "#user"; id -un',
  'echo "#cpu"; head -n1 /proc/stat',
  'echo "#mem"; grep -E "^(MemTotal|MemAvailable|MemFree):" /proc/meminfo',
  'echo "#up"; cat /proc/uptime',
  'echo "#net"; cat /proc/net/dev',
  'echo "#disk"; df -Pk'
].join('; ')

/** `LC_ALL=C` so numbers and `df` headings do not arrive translated. */
export const probeCommand = `LC_ALL=C; ${PROBE_COMMAND}`

export interface DiskUsage {
  mount: string
  usedPercent: number
}

/** One reading. Counters here are totals, not rates. */
export interface RemoteSample {
  at: number
  user?: string
  /** Jiffies spent doing anything, and in total. */
  cpuBusy?: number
  cpuTotal?: number
  memTotalKb?: number
  memUsedKb?: number
  uptimeSeconds?: number
  rxBytes?: number
  txBytes?: number
  disks: DiskUsage[]
}

/** What two readings say together, ready to draw. */
export interface RemoteStats {
  user?: string
  cpuPercent?: number
  memUsedKb?: number
  memTotalKb?: number
  rxPerSecond?: number
  txPerSecond?: number
  uptimeSeconds?: number
  disks: DiskUsage[]
}

function num(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

export function parseProbe(output: string, at: number): RemoteSample {
  const sample: RemoteSample = { at, disks: [] }
  let section = ''
  let memTotal: number | undefined
  let memFree: number | undefined
  let memAvailable: number | undefined
  let rx = 0
  let tx = 0
  let sawInterface = false

  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      section = line.slice(1)
      continue
    }

    if (section === 'user') {
      sample.user = line
      // `cpu ` is the total across cores; `cpu0`, `cpu1` … are the cores
      // themselves and would overwrite it with one core's figures.
    } else if (section === 'cpu' && /^cpu\s/.test(line)) {
      // user nice system idle iowait irq softirq steal …
      const fields = line.split(/\s+/).slice(1).map(Number).filter(Number.isFinite)
      if (fields.length >= 5) {
        const total = fields.reduce((sum, n) => sum + n, 0)
        // Waiting on disk is not the processor working, so iowait joins idle.
        sample.cpuTotal = total
        sample.cpuBusy = total - fields[3] - (fields[4] ?? 0)
      }
    } else if (section === 'mem') {
      const [key, value] = line.split(/:\s*/)
      const kb = num(value?.split(/\s+/)[0])
      if (key === 'MemTotal') memTotal = kb
      if (key === 'MemFree') memFree = kb
      if (key === 'MemAvailable') memAvailable = kb
    } else if (section === 'up') {
      sample.uptimeSeconds = num(line.split(/\s+/)[0])
    } else if (section === 'net') {
      const [name, rest] = line.split(':')
      if (rest === undefined) continue
      const iface = name.trim()
      // Loopback is the host talking to itself; counting it would report
      // traffic on a link that does not exist.
      if (iface === 'lo') continue
      const fields = rest.trim().split(/\s+/).map(Number)
      if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue
      rx += fields[0]
      tx += fields[8]
      sawInterface = true
    } else if (section === 'disk') {
      const fields = line.split(/\s+/)
      // Only real block devices: tmpfs, overlays and the like are noise here.
      if (fields.length < 6 || !fields[0].startsWith('/dev/')) continue
      const percent = num(fields[4].replace('%', ''))
      if (percent === undefined) continue
      // `df -P` keeps the mount point last, and it may contain spaces.
      sample.disks.push({ mount: fields.slice(5).join(' '), usedPercent: percent })
    }
  }

  if (memTotal !== undefined) {
    sample.memTotalKb = memTotal
    // MemAvailable accounts for reclaimable cache; MemFree alone reports a
    // healthy Linux box as nearly out of memory.
    const free = memAvailable ?? memFree
    if (free !== undefined) sample.memUsedKb = Math.max(0, memTotal - free)
  }
  if (sawInterface) {
    sample.rxBytes = rx
    sample.txBytes = tx
  }
  return sample
}

/**
 * Turns two readings into rates. `previous` missing — the first tick — gives
 * the standing values only, with no rate yet invented for them.
 */
export function diffSamples(previous: RemoteSample | undefined, next: RemoteSample): RemoteStats {
  const stats: RemoteStats = {
    user: next.user,
    memUsedKb: next.memUsedKb,
    memTotalKb: next.memTotalKb,
    uptimeSeconds: next.uptimeSeconds,
    disks: next.disks
  }
  if (!previous) return stats

  const seconds = (next.at - previous.at) / 1000
  if (seconds <= 0) return stats

  if (
    previous.cpuTotal !== undefined &&
    next.cpuTotal !== undefined &&
    previous.cpuBusy !== undefined &&
    next.cpuBusy !== undefined
  ) {
    const total = next.cpuTotal - previous.cpuTotal
    const busy = next.cpuBusy - previous.cpuBusy
    // A reboot between ticks resets the counters; a negative delta is not a
    // measurement and must not be drawn as one.
    if (total > 0 && busy >= 0) stats.cpuPercent = Math.min(100, (busy / total) * 100)
  }

  if (previous.rxBytes !== undefined && next.rxBytes !== undefined) {
    const delta = next.rxBytes - previous.rxBytes
    if (delta >= 0) stats.rxPerSecond = delta / seconds
  }
  if (previous.txBytes !== undefined && next.txBytes !== undefined) {
    const delta = next.txBytes - previous.txBytes
    if (delta >= 0) stats.txPerSecond = delta / seconds
  }
  return stats
}

/** Coarse on purpose: "4 days" reads better on a strip than "4d 03:17:42". */
export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `${hours} h`
  return `${Math.max(1, Math.floor(seconds / 60))} min`
}

export function formatRate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mb/s`
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} Kb/s`
  return `${Math.round(bits)} b/s`
}

export function formatMemory(usedKb: number, totalKb: number): string {
  const gb = (kb: number): string => (kb / 1024 / 1024).toFixed(2)
  return `${gb(usedKb)} / ${gb(totalKb)} GB`
}
