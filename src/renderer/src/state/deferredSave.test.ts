import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferredSave } from './deferredSave'

afterEach(() => vi.useRealTimers())
describe('layout persistence', () => {
  it('coalesces a drag and saves its latest state', () => {
    vi.useFakeTimers()
    let value = 0
    const save = vi.fn(() => value)
    const pending = deferredSave(save)
    for (; value < 20; value++) {
      pending.schedule()
      vi.advanceTimersByTime(16)
    }
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(save).toHaveReturnedWith(20)
    expect(save).toHaveBeenCalledTimes(1)
  })
  it('flushes on leaving, and bounds delay even during continuous changes', () => {
    vi.useFakeTimers()
    const save = vi.fn()
    const pending = deferredSave(save)
    for (let i = 0; i < 20; i++) {
      pending.schedule()
      vi.advanceTimersByTime(100)
    }
    expect(save).toHaveBeenCalledTimes(1)
    pending.schedule()
    pending.flush()
    pending.flush()
    vi.advanceTimersByTime(5000)
    expect(save).toHaveBeenCalledTimes(2)
  })
})
