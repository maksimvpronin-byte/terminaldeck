import { describe, it, expect } from 'vitest'
import { buttonEvent, PTR, PTR_X, wheelFlags, wheelUnits } from './rdpInput'

describe('buttonEvent', () => {
  it('does not confuse the middle button with the right one', () => {
    // The browser numbers them 0,1,2 as left,middle,right; the protocol's own
    // BUTTON2 is the right one. Swapping these makes a middle-click paste.
    expect(buttonEvent(1, true)).toEqual({ flags: PTR.middle | PTR.down, extended: false })
    expect(buttonEvent(2, true)).toEqual({ flags: PTR.right | PTR.down, extended: false })
  })

  it('clears the down bit on release', () => {
    expect(buttonEvent(0, false)).toEqual({ flags: PTR.left, extended: false })
  })

  it('sends the side buttons on the extended message', () => {
    expect(buttonEvent(3, true)).toEqual({ flags: PTR_X.back | PTR_X.down, extended: true })
    expect(buttonEvent(4, false)).toEqual({ flags: PTR_X.forward, extended: true })
  })

  it('has nothing to send for a button it does not know', () => {
    expect(buttonEvent(9, true)).toBeNull()
  })
})

describe('wheelUnits', () => {
  it('turns the browser’s direction into the protocol’s', () => {
    // Scrolling down is positive in a browser and negative on the wire.
    expect(wheelUnits(100, 0)).toBeLessThan(0)
    expect(wheelUnits(-100, 0)).toBeGreaterThan(0)
  })

  it('makes a notch out of a notch', () => {
    expect(wheelUnits(-100, 0)).toBe(120)
  })

  it('keeps a trackpad’s small steps small', () => {
    // Rounding every one of these up to a notch is what turns a smooth scroll
    // into a jumping one.
    expect(wheelUnits(-10, 0)).toBe(12)
    expect(wheelUnits(-1, 0)).toBe(1)
  })

  it('reads lines and pages as well as pixels', () => {
    expect(wheelUnits(-1, 1)).toBe(Math.round((16 * 120) / 100))
    expect(wheelUnits(-1, 2)).toBe(255)
  })

  it('stays inside the eight bits the field has', () => {
    expect(wheelUnits(-100000, 0)).toBe(255)
    expect(wheelUnits(100000, 0)).toBe(-255)
  })
})

describe('wheelFlags', () => {
  /** What the far end does with the field, from FreeRDP's own client. */
  const asRead = (flags: number): number => {
    const value = flags & 0xff
    return flags & PTR.wheelNegative ? -1 * (0x100 - value) : value
  }

  it('survives the round trip in both directions', () => {
    // The whole point: a turn must arrive as the turn that was made. Sending
    // the magnitude beside a sign bit made one direction arrive as 253.
    for (const units of [1, 3, 120, 255, -1, -3, -120, -255]) {
      expect(asRead(wheelFlags(units)!)).toBe(units)
    }
  })

  it('says which axis it turned on', () => {
    expect(wheelFlags(120)! & PTR.wheel).toBe(PTR.wheel)
    expect(wheelFlags(120, true)! & PTR.hwheel).toBe(PTR.hwheel)
  })

  it('marks a backwards turn, and only a backwards one', () => {
    expect(wheelFlags(-120)! & PTR.wheelNegative).toBe(PTR.wheelNegative)
    expect(wheelFlags(120)! & PTR.wheelNegative).toBe(0)
  })

  it('has nothing to send for a wheel that did not turn', () => {
    expect(wheelFlags(0)).toBeNull()
  })

  it('keeps the rotation inside the byte that carries it', () => {
    for (const units of [1, 255, -1, -255]) {
      const value = wheelFlags(units)! & 0xff
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(0xff)
    }
  })
})
