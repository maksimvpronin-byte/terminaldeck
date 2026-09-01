import { describe, it, expect } from 'vitest'
import {
  buildTransferPlan,
  defaultDecisions,
  isRefusable,
  shouldWrite,
  type DestInfo
} from './transferPlan'
import type { TransferItem } from './types'

const item = (sourcePath: string, destPath: string, size = 10): TransferItem => ({
  sourcePath,
  destPath,
  sourceSize: size,
  sourceMtime: 1_700_000_000_000
})

const file = (over: Partial<DestInfo> = {}): DestInfo => ({
  size: 99,
  mtime: 1_600_000_000_000,
  isDirectory: false,
  isSymlink: false,
  ...over
})

const nothing = (): null => null

describe('buildTransferPlan', () => {
  it('reports no conflicts when the destination is empty', () => {
    const plan = buildTransferPlan('upload', [item('/a.txt', '/srv/a.txt')], nothing)
    expect(plan.conflicts).toEqual([])
    expect(plan.collisions).toEqual([])
    expect(plan.items).toHaveLength(1)
  })

  it('sums the bytes it would move', () => {
    const plan = buildTransferPlan(
      'upload',
      [item('/a', '/srv/a', 100), item('/b', '/srv/b', 250)],
      nothing
    )
    expect(plan.totalBytes).toBe(350)
  })

  it('flags an existing file as replaceable, carrying both sides for the dialog', () => {
    const plan = buildTransferPlan('upload', [item('/a.txt', '/srv/a.txt')], () => file())
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({
      destPath: '/srv/a.txt',
      reason: 'file',
      destSize: 99,
      sourceSize: 10
    })
    expect(isRefusable(plan.conflicts[0].reason)).toBe(false)
  })

  it('refuses a directory sitting where a file must go', () => {
    const plan = buildTransferPlan('upload', [item('/a', '/srv/a')], () =>
      file({ isDirectory: true })
    )
    expect(plan.conflicts[0].reason).toBe('directory')
    expect(isRefusable('directory')).toBe(true)
  })

  it('refuses to write through a symlink', () => {
    const plan = buildTransferPlan('upload', [item('/a', '/srv/a')], () =>
      file({ isSymlink: true })
    )
    expect(plan.conflicts[0].reason).toBe('symlink')
    expect(isRefusable('symlink')).toBe(true)
  })

  it('treats an unreadable destination as occupied, never as empty', () => {
    // Mistaking "permission denied" for "nothing there" would overwrite blind.
    const plan = buildTransferPlan('upload', [item('/a', '/srv/a')], () =>
      file({ unreadable: true })
    )
    expect(plan.conflicts[0].reason).toBe('unreadable')
    expect(isRefusable('unreadable')).toBe(true)
  })

  it('spots two sources landing on one destination', () => {
    const plan = buildTransferPlan(
      'upload',
      [item('/dir/README', '/srv/readme'), item('/dir/readme', '/srv/readme')],
      nothing
    )
    expect(plan.collisions).toEqual([
      { destPath: '/srv/readme', sourcePaths: ['/dir/README', '/dir/readme'] }
    ])
  })

  it('does not call a single source landing on its own destination a collision', () => {
    const plan = buildTransferPlan('upload', [item('/a', '/srv/a'), item('/b', '/srv/b')], nothing)
    expect(plan.collisions).toEqual([])
  })

  it('works the same for downloads', () => {
    const plan = buildTransferPlan('download', [item('/srv/a', '/home/a')], () => file())
    expect(plan.direction).toBe('download')
    expect(plan.conflicts[0].destPath).toBe('/home/a')
  })

  it('works the same host to host, where both paths are remote', () => {
    const plan = buildTransferPlan('relay', [item('/srv/a', '/opt/a')], () => file())
    expect(plan.direction).toBe('relay')
    expect(plan.conflicts[0].destPath).toBe('/opt/a')
    // The far side is asked about exactly as a local destination would be: a
    // file that is already there is replaceable, and nothing else is.
    expect(isRefusable(plan.conflicts[0].reason)).toBe(false)
  })

  it('refuses a relay onto a directory, same as any other direction', () => {
    const plan = buildTransferPlan('relay', [item('/srv/a', '/opt/a')], () =>
      file({ isDirectory: true })
    )
    expect(plan.conflicts[0].reason).toBe('directory')
  })
})

describe('defaultDecisions', () => {
  it('starts every conflict on skip, so a stray Enter destroys nothing', () => {
    const plan = buildTransferPlan(
      'upload',
      [item('/a', '/srv/a'), item('/b', '/srv/b')],
      (dest) => (dest === '/srv/a' ? file() : null)
    )
    expect(defaultDecisions(plan)).toEqual({ '/srv/a': 'skip' })
  })
})

describe('shouldWrite', () => {
  it('writes anything nobody objected to', () => {
    expect(shouldWrite('/srv/new', {})).toBe(true)
  })

  it('honours a skip', () => {
    expect(shouldWrite('/srv/a', { '/srv/a': 'skip' })).toBe(false)
  })

  it('honours an overwrite', () => {
    expect(shouldWrite('/srv/a', { '/srv/a': 'overwrite' })).toBe(true)
  })

  /**
   * The case the other two answers disagreed about.
   *
   * `defaultDecisions` fills every conflict with `skip` and says skipping is
   * the default; the dialog shows `skip` for anything undecided. This used to
   * read the same silence as permission to overwrite — so a conflict whose
   * answer went missing was destroyed while both of the other two claimed it
   * had been left alone.
   */
  it('leaves a conflict alone when nothing was decided about it', () => {
    expect(shouldWrite('/srv/a', {}, new Set(['/srv/a']))).toBe(false)
  })

  it('still writes a destination that raised no conflict', () => {
    expect(shouldWrite('/srv/new', {}, new Set(['/srv/a']))).toBe(true)
  })

  it('lets an explicit overwrite through even for a conflict', () => {
    expect(shouldWrite('/srv/a', { '/srv/a': 'overwrite' }, new Set(['/srv/a']))).toBe(true)
  })
})
