import { describe, it, expect, vi } from 'vitest'
import { transferProgress } from './transferProgress'

describe('transfer progress', () => {
  it('coalesces a burst, reports later progress and always delivers completion', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const send = vi.fn()
    const report = transferProgress(send)
    for (let i = 0; i < 1000; i++) report({ transferred: i, total: 2000 })
    expect(send).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(100)
    report({ transferred: 1500, total: 2000 })
    report({ transferred: 2000, total: 2000 })
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenLastCalledWith({ transferred: 2000, total: 2000 })
  })
})
