import { describe, it, expect } from 'vitest'
import { placeOn, restorePlacement } from './windowPlacement'

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

describe('restorePlacement', () => {
  const MIN = { width: 900, height: 560 }
  const laptop = { x: 0, y: 25, width: 1512, height: 920 }
  const external = { x: 1512, y: -200, width: 2560, height: 1415 }

  it('puts the window back where it was, on the display it was on', () => {
    const saved = { x: 1700, y: 0, width: 1600, height: 1000 }
    expect(restorePlacement(saved, [laptop, external], MIN)).toEqual(saved)
  })

  it('pulls a window hanging over an edge back inside, shrinking it if need be', () => {
    expect(restorePlacement({ x: 1000, y: 100, width: 1200, height: 1200 }, [laptop], MIN)).toEqual(
      { x: 312, y: 25, width: 1200, height: 920 }
    )
  })

  it('centres a window from a display that is gone on the first one', () => {
    expect(restorePlacement({ x: 3000, y: 100, width: 1280, height: 800 }, [laptop], MIN)).toEqual({
      x: 116,
      y: 85,
      width: 1280,
      height: 800
    })
  })

  it('does not trust a sliver: a corner on screen is not a window anyone can reach', () => {
    expect(restorePlacement({ x: 1480, y: 900, width: 1280, height: 800 }, [laptop], MIN)).toEqual({
      x: 116,
      y: 85,
      width: 1280,
      height: 800
    })
  })

  it('never makes it smaller than the window allows', () => {
    expect(restorePlacement({ x: 10, y: 40, width: 200, height: 100 }, [laptop], MIN)).toEqual({
      x: 10,
      y: 40,
      width: 900,
      height: 560
    })
  })
})
