import { describe, it, expect } from 'vitest'
import { MAX_DESKTOP_AREA, desktopSizeFor } from './desktopSize'
import { createRecordReader } from '../main/rdp/recordStream'
import type { RdpView } from './types'

/** A host that has decided nothing in particular. */
const plain: RdpView = {
  resolution: 'fit',
  desktopWidth: 1920,
  desktopHeight: 1080,
  pixelBudget: 3.5,
  magnification: 0,
  sendDensity: false,
  commandAsControl: false
}

const pane = { width: 1400, height: 900 }
/** Small enough that the pixel budget never bites, so magnification is alone. */
const small = { width: 800, height: 600 }

describe('the size a desktop is asked for', () => {
  it('is nothing at all before the pane has one', () => {
    expect(desktopSizeFor(plain, null, 1)).toBeNull()
    expect(desktopSizeFor(plain, { width: 0, height: 0 }, 1)).toBeNull()
  })

  it('is the pane itself on a display with one pixel per point', () => {
    expect(desktopSizeFor(plain, pane, 1)).toEqual({ width: 1400, height: 900, factor: 1 })
  })

  /**
   * The default on a Retina display: every pixel drawn as four, which comes out
   * the size an ordinary monitor would have given.
   */
  it('is still the pane on a denser display, unless asked otherwise', () => {
    expect(desktopSizeFor(plain, pane, 2)).toEqual({ width: 1400, height: 900, factor: 1 })
  })

  it('is every pixel the display has when the far end is told the density', () => {
    const look = { ...plain, sendDensity: true }

    expect(desktopSizeFor(look, small, 2)).toEqual({ width: 1600, height: 1200, factor: 2 })
  })

  it('follows a magnification stated by hand rather than the display', () => {
    // 100% means "one desktop pixel per point", which on a Retina display is
    // twice the pixels and half the apparent size.
    expect(desktopSizeFor({ ...plain, magnification: 100 }, small, 2)?.factor).toBe(2)
    // 200% is what the display would have chosen anyway.
    expect(desktopSizeFor({ ...plain, magnification: 200 }, small, 2)?.factor).toBe(1)
  })

  it('will not magnify past four, however large the number', () => {
    // Nine times over would be a factor of 8/9 of a point; four is the ceiling,
    // so the eightfold display still asks for twice the points.
    expect(desktopSizeFor({ ...plain, magnification: 900 }, small, 8)?.factor).toBe(2)
  })

  /**
   * Worth stating because it surprised the person writing these tests: a
   * full-screen pane on a Retina display asking for every pixel wants 5 million
   * of them, and the default budget is 3.5.
   */
  it('is capped by the budget before magnification has had its way', () => {
    const size = desktopSizeFor({ ...plain, sendDensity: true }, pane, 2)

    expect(size!.factor).toBeLessThan(2)
    expect(size!.width * size!.height).toBeLessThanOrEqual(3.5 * 1_000_000)
  })

  describe('a pinned size', () => {
    it('is asked for exactly as it was stated', () => {
      const look: RdpView = {
        ...plain,
        resolution: 'fixed',
        desktopWidth: 1024,
        desktopHeight: 768
      }

      expect(desktopSizeFor(look, pane, 2)).toEqual({ width: 1024, height: 768, factor: 1 })
    })

    it('is stated even before the pane has a size of its own', () => {
      const look: RdpView = {
        ...plain,
        resolution: 'fixed',
        desktopWidth: 1024,
        desktopHeight: 768
      }

      expect(desktopSizeFor(look, null, 1)).not.toBeNull()
    })
  })

  /**
   * The subtlest line in here: past the budget the factor comes down until the
   * request fits, and it is never raised to meet a budget it is already under.
   */
  describe('the host’s pixel budget', () => {
    it('is not spent when the request is already under it', () => {
      // 1400 × 900 = 1.26M pixels, well inside 3.5M.
      expect(desktopSizeFor(plain, pane, 1)?.factor).toBe(1)
    })

    it('brings a request that would exceed it back under', () => {
      const big = { width: 2560, height: 1440 }
      const size = desktopSizeFor({ ...plain, sendDensity: true }, big, 2)

      // 2560 × 1440 at twice the density would be 29.5M pixels.
      expect(size).not.toBeNull()
      expect(size!.width * size!.height).toBeLessThanOrEqual(3.5 * 1_000_000)
      expect(size!.factor).toBeLessThan(2)
    })

    it('is obeyed as the host sets it, not as it comes by default', () => {
      const big = { width: 2560, height: 1440 }
      const generous = desktopSizeFor({ ...plain, sendDensity: true, pixelBudget: 8 }, big, 2)
      const mean = desktopSizeFor({ ...plain, sendDensity: true, pixelBudget: 1 }, big, 2)

      expect(generous!.width).toBeGreaterThan(mean!.width)
      expect(mean!.width * mean!.height).toBeLessThanOrEqual(1_000_000)
    })
  })

  /** [MS-RDPEDISP] takes 200 to 8192 pixels and refuses an odd width. */
  describe('what the protocol will accept', () => {
    it('never asks for an odd number of pixels', () => {
      const size = desktopSizeFor(plain, { width: 1401, height: 903 }, 1)

      expect(size!.width % 2).toBe(0)
      expect(size!.height % 2).toBe(0)
    })

    it('never asks for less than the floor', () => {
      const size = desktopSizeFor(plain, { width: 40, height: 30 }, 1)

      expect(size).toEqual({ width: 200, height: 200, factor: 1 })
    })

    it('never asks for more than the ceiling', () => {
      // A budget high enough that only the protocol's own limit is left to bite,
      // on a pane wide enough to reach it without the area doing so first.
      const look = { ...plain, sendDensity: true, pixelBudget: 500 }
      const size = desktopSizeFor(look, { width: 10000, height: 300 }, 1)

      expect(size!.width).toBe(8192)
      expect(size!.height).toBe(300)
    })
  })

  it('treats a display that reports no density as an ordinary one', () => {
    expect(desktopSizeFor(plain, pane, 0)).toEqual({ width: 1400, height: 900, factor: 1 })
  })
})

/**
 * A whole frame crosses to the window as one record, and the reader refuses a
 * record larger than a 4K desktop. A size asked for past that is a session
 * ended by its own first full frame — a 5K display did exactly that.
 */
describe('a desktop larger than a frame can carry', () => {
  /** Whether a whole frame of this size gets through the reader. */
  function frameArrives(size: { width: number; height: number }): boolean {
    let arrived = false
    const reader = createRecordReader(() => (arrived = true))
    const pixels = size.width * size.height * 4
    const header = Buffer.alloc(13)
    header[0] = 2
    header.writeUInt32LE(8 + pixels, 1)
    reader.push(header)
    // Only the header is needed to be refused, so only a refusal is checked
    // without allocating the frame itself.
    if (reader.broken) return false
    reader.push(Buffer.alloc(pixels))
    return arrived
  }

  it('is asked for smaller when a 5K display would ask for its own pixels', () => {
    const size = desktopSizeFor(
      { ...plain, magnification: 100, pixelBudget: 100 },
      { width: 2560, height: 1440 },
      2
    )!
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_DESKTOP_AREA)
    expect(size.width / size.height).toBeCloseTo(16 / 9, 2)
    expect(frameArrives(size)).toBe(true)
  })

  it('is asked for smaller when a pinned size is larger than 4K', () => {
    const size = desktopSizeFor(
      { ...plain, resolution: 'fixed', desktopWidth: 5120, desktopHeight: 2880 },
      pane,
      1
    )!
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_DESKTOP_AREA)
    expect(size.width % 2).toBe(0)
    expect(size.height % 2).toBe(0)
    expect(frameArrives(size)).toBe(true)
  })

  it('leaves a 4K desktop as it is', () => {
    const size = desktopSizeFor(
      { ...plain, resolution: 'fixed', desktopWidth: 3840, desktopHeight: 2160 },
      pane,
      1
    )
    expect(size).toEqual({ width: 3840, height: 2160, factor: 1 })
  })
})
