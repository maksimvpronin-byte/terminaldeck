import { describe, it, expect } from 'vitest'
import {
  diffSamples,
  formatMemory,
  formatRate,
  formatUptime,
  parseProbe,
  type RemoteSample
} from './remoteStats'

const PROBE = `#user
max
#cpu
cpu  100 20 50 800 30 0 0 0 0 0
cpu0 50 10 25 400 15 0 0 0 0 0
#mem
MemTotal:        5924352 kB
MemFree:          204800 kB
MemAvailable:    4519936 kB
#up
345600.25 1382401.00
#net
Inter-|   Receive                        |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
    lo:  999999    100    0    0    0     0          0         0   999999     100
  eth0: 1000000   2000    0    0    0     0          0         0   500000    1500
#disk
Filesystem     1024-blocks     Used Available Capacity Mounted on
udev              2000000        0   2000000       0% /dev
tmpfs              400000     1000    399000       1% /run
/dev/sda1        41251136 32000000   7000000      82% /
/dev/sda2          500000    50000    450000      11% /boot
`

describe('parseProbe', () => {
  it('reads every section out of one round trip', () => {
    const s = parseProbe(PROBE, 1000)
    expect(s.user).toBe('max')
    expect(s.uptimeSeconds).toBe(345600.25)
    expect(s.memTotalKb).toBe(5924352)
  })

  it('counts iowait as idle, not as work', () => {
    // total 1000, idle 800, iowait 30 -> busy 170
    const s = parseProbe(PROBE, 1000)
    expect(s.cpuTotal).toBe(1000)
    expect(s.cpuBusy).toBe(170)
  })

  it('measures used memory against MemAvailable, not MemFree', () => {
    // Reclaimable cache is not in use; MemFree would call this box nearly full.
    const s = parseProbe(PROBE, 1000)
    expect(s.memUsedKb).toBe(5924352 - 4519936)
  })

  it('falls back to MemFree when the kernel is too old for MemAvailable', () => {
    const s = parseProbe('#mem\nMemTotal: 1000 kB\nMemFree: 400 kB\n', 1000)
    expect(s.memUsedKb).toBe(600)
  })

  it('sums the interfaces but leaves out loopback', () => {
    const s = parseProbe(PROBE, 1000)
    expect(s.rxBytes).toBe(1000000)
    expect(s.txBytes).toBe(500000)
  })

  it('keeps real block devices and drops tmpfs and udev', () => {
    const s = parseProbe(PROBE, 1000)
    expect(s.disks).toEqual([
      { mount: '/', usedPercent: 82 },
      { mount: '/boot', usedPercent: 11 }
    ])
  })

  it('keeps a mount point that has spaces in it', () => {
    const s = parseProbe('#disk\n/dev/sdb1 100 50 50 50% /mnt/my disk\n', 1000)
    expect(s.disks[0].mount).toBe('/mnt/my disk')
  })

  it('leaves fields undefined on a host without /proc', () => {
    // A BSD or macOS host answers with nothing rather than zeroes, and the
    // strip must be able to tell "unknown" from "idle".
    const s = parseProbe('#user\nmax\n#cpu\n#mem\n#up\n#net\n#disk\n', 1000)
    expect(s.cpuTotal).toBeUndefined()
    expect(s.memTotalKb).toBeUndefined()
    expect(s.rxBytes).toBeUndefined()
    expect(s.disks).toEqual([])
  })
})

describe('diffSamples', () => {
  const first: RemoteSample = {
    at: 0,
    cpuBusy: 100,
    cpuTotal: 1000,
    rxBytes: 1000,
    txBytes: 2000,
    disks: []
  }

  it('invents no rate for the first reading', () => {
    const stats = diffSamples(undefined, { ...first, memTotalKb: 100, disks: [] })
    expect(stats.cpuPercent).toBeUndefined()
    expect(stats.rxPerSecond).toBeUndefined()
    expect(stats.memTotalKb).toBe(100)
  })

  it('turns counter differences into a load and a throughput', () => {
    const next: RemoteSample = {
      at: 2000,
      cpuBusy: 150,
      cpuTotal: 1200,
      rxBytes: 3000,
      txBytes: 2500,
      disks: []
    }
    const stats = diffSamples(first, next)
    // 50 busy jiffies out of 200 elapsed
    expect(stats.cpuPercent).toBeCloseTo(25)
    // 2000 bytes over two seconds
    expect(stats.rxPerSecond).toBe(1000)
    expect(stats.txPerSecond).toBe(250)
  })

  it('reports nothing when a reboot has reset the counters', () => {
    const rebooted: RemoteSample = {
      at: 2000,
      cpuBusy: 5,
      cpuTotal: 50,
      rxBytes: 10,
      txBytes: 10,
      disks: []
    }
    const stats = diffSamples(first, rebooted)
    expect(stats.cpuPercent).toBeUndefined()
    expect(stats.rxPerSecond).toBeUndefined()
  })

  it('ignores two readings taken at the same moment', () => {
    expect(diffSamples(first, { ...first, at: 0 }).cpuPercent).toBeUndefined()
  })
})

describe('formatting', () => {
  it('says uptime the way a status strip should', () => {
    expect(formatUptime(345600)).toBe('4 days')
    expect(formatUptime(86400)).toBe('1 day')
    expect(formatUptime(7200)).toBe('2 h')
    expect(formatUptime(90)).toBe('1 min')
    expect(formatUptime(-1)).toBe('')
  })

  it('reports throughput in bits, as network tools do', () => {
    expect(formatRate(7500)).toBe('60.0 Kb/s')
    expect(formatRate(1_250_000)).toBe('10.00 Mb/s')
    expect(formatRate(0)).toBe('0 b/s')
  })

  it('shows memory as used against total', () => {
    expect(formatMemory(1_404_416, 5_924_352)).toBe('1.34 / 5.65 GB')
  })
})
