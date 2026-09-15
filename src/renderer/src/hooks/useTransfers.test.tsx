// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { TransferPlan } from '../../../shared/types'
import { useTransfers } from './useTransfers'

const plan = (conflicting = false): TransferPlan => ({
  direction: 'upload',
  items: [{ sourcePath: '/local/a', destPath: '/srv/a', sourceSize: 1, sourceMtime: 0 }],
  conflicts: conflicting
    ? [
        {
          sourcePath: '/local/a',
          destPath: '/srv/a',
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

    await act(() => result.current.run(plan(true)))
    expect(result.current.pending).not.toBeNull()

    rerender({ connectionId: 'c2' })
    expect(result.current.pending).toBeNull()
    await act(() => result.current.confirm({ '/srv/a': 'overwrite' }))
    expect(runPlan).not.toHaveBeenCalled()
  })
})
