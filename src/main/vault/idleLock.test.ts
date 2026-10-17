import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./Vault', () => ({ vault: {} }))
const { createIdleLock } = await import('./idleLock')

describe('createIdleLock', () => {
  let unlocked: boolean
  const target = {
    isUnlocked: (): boolean => unlocked,
    lock: vi.fn(() => {
      unlocked = false
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    unlocked = true
    target.lock.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('locks the vault the set minutes after the window closed', () => {
    const lock = createIdleLock(target)
    lock.setMinutes(15)
    lock.pageGone()
    vi.advanceTimersByTime(15 * 60_000 - 1)
    expect(target.lock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(target.lock).toHaveBeenCalledOnce()
  })

  it('leaves the count to a window that opened in time', () => {
    const lock = createIdleLock(target)
    lock.setMinutes(15)
    lock.pageGone()
    vi.advanceTimersByTime(10 * 60_000)
    lock.pageBack()
    vi.advanceTimersByTime(60 * 60_000)
    expect(target.lock).not.toHaveBeenCalled()
  })

  it('never locks when the setting says never', () => {
    const lock = createIdleLock(target)
    lock.setMinutes(0)
    lock.pageGone()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(target.lock).not.toHaveBeenCalled()
  })

  it('takes a value outside the dialog’s range as no lock', () => {
    const lock = createIdleLock(target)
    for (const odd of [-5, 1.5, 481, Number.NaN]) {
      lock.setMinutes(odd)
      lock.pageGone()
    }
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(target.lock).not.toHaveBeenCalled()
  })

  it('starts nothing for a vault already locked', () => {
    unlocked = false
    const lock = createIdleLock(target)
    lock.setMinutes(1)
    lock.pageGone()
    vi.advanceTimersByTime(60_000)
    expect(target.lock).not.toHaveBeenCalled()
  })

  it('counts from the latest close, not the first', () => {
    const lock = createIdleLock(target)
    lock.setMinutes(5)
    lock.pageGone()
    vi.advanceTimersByTime(4 * 60_000)
    lock.pageGone()
    vi.advanceTimersByTime(4 * 60_000)
    expect(target.lock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(target.lock).toHaveBeenCalledOnce()
  })
})
