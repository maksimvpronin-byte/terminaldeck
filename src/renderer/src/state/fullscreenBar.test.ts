import { describe, it, expect } from 'vitest'
import { barLeft } from './fullscreenBar'

describe('barLeft', () => {
  it('centres the bar on the point it was left at', () => {
    expect(barLeft(0.5, 300, 1920)).toBe(810)
    expect(barLeft(0.25, 300, 2000)).toBe(350)
  })

  it('keeps the whole bar on the screen at either edge', () => {
    expect(barLeft(0, 300, 1920)).toBe(0)
    expect(barLeft(1, 300, 1920)).toBe(1620)
  })

  it('pins a bar wider than the screen to the left edge', () => {
    expect(barLeft(0.5, 400, 300)).toBe(0)
  })
})
