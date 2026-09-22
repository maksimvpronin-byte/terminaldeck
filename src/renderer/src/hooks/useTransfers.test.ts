// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTransfers } from './useTransfers'
import type { TransferPlan } from '../../../shared/types'

function plan(path: string): TransferPlan {
  return {
    direction: 'upload',
    items: [{ sourcePath: path, destPath: `/srv/${path}`, sourceSize: 1, sourceMtime: 0 }],
    conflicts: [],
    collisions: [],
    totalBytes: 1
  }
}

/**
 * A batch is one plan per dropped item, run in turn. Each plan cleared the
 * message as it started, so the first file's failure was gone by the time the
 * second had begun — and a batch whose last item worked read as if all had.
 */
describe('a batch of transfers', () => {
  it('keeps what went wrong with an early item once the later ones have run', async () => {
    window.td.sftp.runPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('first.txt: Permission denied'))
      .mockResolvedValueOnce({ written: 1, skipped: 0, changed: [] })
    const { result } = renderHook(() => useTransfers({ connectionId: 'c1', onFinished: () => {} }))

    await act(async () => {
      result.current.startBatch()
      await result.current.run(plan('first.txt'), undefined, 'c1')
      await result.current.run(plan('second.txt'), undefined, 'c1')
    })

    expect(result.current.outcome).toContain('first.txt: Permission denied')
  })

  it('starts the next batch clean', async () => {
    window.td.sftp.runPlan = vi
      .fn()
      .mockRejectedValueOnce(new Error('first.txt: Permission denied'))
      .mockResolvedValueOnce({ written: 1, skipped: 0, changed: [] })
    const { result } = renderHook(() => useTransfers({ connectionId: 'c1', onFinished: () => {} }))

    await act(async () => {
      await result.current.run(plan('first.txt'), undefined, 'c1')
    })
    await act(async () => {
      result.current.startBatch()
      await result.current.run(plan('second.txt'), undefined, 'c1')
    })

    expect(result.current.outcome).toBeNull()
  })
})
