import { it, expect, vi } from 'vitest'
import { rereadOnFailure } from './reconcile'

it('keeps the original error even if rereading also fails', async () => {
  const failure = new Error('vault cleanup failed')
  const reread = vi.fn().mockRejectedValue(new Error('read failed'))
  await expect(rereadOnFailure(() => Promise.reject(failure), reread)).rejects.toBe(failure)
  expect(reread).toHaveBeenCalledOnce()
})

it('returns a successful mutation without requesting another read', async () => {
  const reread = vi.fn()
  await expect(rereadOnFailure(() => Promise.resolve('saved'), reread)).resolves.toBe('saved')
  expect(reread).not.toHaveBeenCalled()
})
