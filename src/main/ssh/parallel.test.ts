import { describe, it, expect } from 'vitest'
import { forEachConcurrent } from './parallel'

describe('bounded metadata requests', () => {
  it('overlaps requests, caps concurrency and visits every item once', async () => {
    let active = 0,
      peak = 0
    const seen: number[] = []
    await forEachConcurrent(
      Array.from({ length: 41 }, (_, i) => i),
      async (item) => {
        peak = Math.max(peak, ++active)
        await new Promise<void>((resolve) => setImmediate(resolve))
        seen.push(item)
        active--
      }
    )
    expect(peak).toBe(8)
    expect(active).toBe(0)
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 41 }, (_, i) => i))
  })
  it('waits for outstanding requests before rejecting', async () => {
    let finished = false
    await expect(
      forEachConcurrent([0, 1], async (item) => {
        if (!item) throw new Error('denied')
        await new Promise<void>((resolve) => setImmediate(resolve))
        finished = true
      })
    ).rejects.toThrow('denied')
    expect(finished).toBe(true)
  })
})
