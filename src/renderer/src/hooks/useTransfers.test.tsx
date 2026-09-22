// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { TransferPlan } from '../../../shared/types'
import { useTransfers } from './useTransfers'

const plan = (conflicting = false, name = 'a'): TransferPlan => ({
  direction: 'upload',
  items: [
    { sourcePath: `/local/${name}`, destPath: `/srv/${name}`, sourceSize: 1, sourceMtime: 0 }
  ],
  conflicts: conflicting
    ? [
        {
          sourcePath: `/local/${name}`,
          destPath: `/srv/${name}`,
          sourceSize: 1,
          sourceMtime: 0,
          destSize: 1,
          destMtime: 0,
          reason: 'file'
        }
      ]
    : [],
  collisions: [],
  totalBytes: 1
})

describe('running a transfer from a file panel', () => {
  /**
   * The listing refreshes after every upload, and used to clear the one
   * message there was — the transfer's failure included.
   */
  it('keeps a failed transfer said after the listing refreshes', async () => {
    window.td.sftp = {
      runPlan: vi.fn().mockRejectedValue(new Error('Permission denied'))
    } as unknown as typeof window.td.sftp
    const refreshed = vi.fn()
    const { result } = renderHook(() => useTransfers({ connectionId: 'c1', onFinished: refreshed }))

    await act(() => result.current.run(plan()))

    expect(refreshed).toHaveBeenCalled()
    expect(result.current.outcome).toMatch(/Permission denied/)
  })

  it('drops an unanswered plan when the panel moves to another connection', async () => {
    const runPlan = vi.fn().mockResolvedValue({ written: 1, skipped: 0, changed: [] })
    window.td.sftp = { runPlan } as unknown as typeof window.td.sftp
    const { result, rerender } = renderHook(
      ({ connectionId }) => useTransfers({ connectionId, onFinished: () => undefined }),
      { initialProps: { connectionId: 'c1' } }
    )

    let done = false
    act(() => {
      void result.current.run(plan(true)).then(() => (done = true))
    })
    await act(() => Promise.resolve())
    expect(result.current.pending).not.toBeNull()

    rerender({ connectionId: 'c2' })
    expect(result.current.pending).toBeNull()
    // And the batch waiting on it is let go, rather than left hanging.
    await act(() => Promise.resolve())
    expect(done).toBe(true)
    await act(() => result.current.confirm({ '/srv/a': 'overwrite' }))
    expect(runPlan).not.toHaveBeenCalled()
  })

  /**
   * `run` returned as soon as the conflict dialog opened, so a batch went on
   * to its next item and that plan replaced the one being asked about: of two
   * files with conflicts, only the second was ever copied.
   */
  describe('a batch of several plans', () => {
    function setUp() {
      const runPlan = vi.fn().mockResolvedValue({ written: 1, skipped: 0, changed: [] })
      window.td.sftp = { runPlan } as unknown as typeof window.td.sftp
      const hook = renderHook(() =>
        useTransfers({ connectionId: 'c1', onFinished: () => undefined })
      )
      const copied = (): string[] =>
        runPlan.mock.calls.map((c) => (c[1] as TransferPlan).items[0].destPath)
      /** The panel's loop: each plan in turn, waiting on each. */
      const batch = (plans: TransferPlan[]): Promise<void> =>
        (async () => {
          for (const p of plans) await hook.result.current.run(p, undefined, 'c1')
        })()
      return { hook, copied, batch }
    }
    const flush = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 0)))

    it('asks about each conflict in turn and copies every one that is confirmed', async () => {
      const { hook, copied, batch } = setUp()
      let finished = false
      void batch([plan(true, 'a'), plan(true, 'b')]).then(() => (finished = true))

      await flush()
      expect(hook.result.current.pending?.plan.items[0].destPath).toBe('/srv/a')
      await act(() => hook.result.current.confirm({ '/srv/a': 'overwrite' }))
      await flush()
      expect(hook.result.current.pending?.plan.items[0].destPath).toBe('/srv/b')
      await act(() => hook.result.current.confirm({ '/srv/b': 'overwrite' }))
      await flush()

      expect(copied()).toEqual(['/srv/a', '/srv/b'])
      expect(finished).toBe(true)
    })

    it('holds the plain files behind a question until it is answered', async () => {
      const { hook, copied, batch } = setUp()
      void batch([plan(false, 'a'), plan(true, 'b'), plan(false, 'c')])

      await flush()
      expect(copied()).toEqual(['/srv/a'])
      expect(hook.result.current.pending?.plan.items[0].destPath).toBe('/srv/b')

      await act(() => hook.result.current.confirm({ '/srv/b': 'overwrite' }))
      await flush()
      expect(copied()).toEqual(['/srv/a', '/srv/b', '/srv/c'])
    })

    it('goes on to the next plan when one is cancelled', async () => {
      const { hook, copied, batch } = setUp()
      void batch([plan(true, 'a'), plan(false, 'b')])

      await flush()
      act(() => hook.result.current.cancel())
      await flush()

      expect(copied()).toEqual(['/srv/b'])
      expect(hook.result.current.pending).toBeNull()
    })
  })
})
