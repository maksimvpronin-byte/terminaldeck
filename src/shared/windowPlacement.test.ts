import { describe, it, expect } from 'vitest'
import { placeOn } from './windowPlacement'

describe('placeOn', () => {
  it('keeps the size and centres the window on the other display', () => {
    expect(
      placeOn(
        { x: 100, y: 80, width: 1280, height: 800 },
        { x: 1920, y: 0, width: 2560, height: 1400 }
      )
    ).toEqual({ x: 1920 + 640, y: 300, width: 1280, height: 800 })
  })

  it('shrinks a window to a display too small for it', () => {
    expect(
      placeOn(
        { x: 0, y: 0, width: 2560, height: 1400 },
        { x: -1366, y: 25, width: 1366, height: 743 }
      )
    ).toEqual({ x: -1366, y: 25, width: 1366, height: 743 })
  })
})
