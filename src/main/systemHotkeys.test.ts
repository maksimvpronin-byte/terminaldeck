import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
vi.mock('./diagnostics', () => ({ diag: vi.fn() }))

import { hotkeyGate, type HotkeySwitch, type TakenMark } from './systemHotkeys'

function fakeSwitch(accepts = true): HotkeySwitch & { calls: boolean[] } {
  const calls: boolean[] = []
  return {
    calls,
    setEnabled: (enabled) => {
      calls.push(enabled)
      return accepts
    }
  }
}

function fakeMark(present = false): TakenMark & { present: boolean } {
  const mark = {
    present,
    exists: () => mark.present,
    set: (taken: boolean) => {
      mark.present = taken
    }
  }
  return mark
}

const everything = { desktopHoldsKeyboard: true, fullScreen: true, focused: true }

describe('hotkeyGate', () => {
  it('takes ⌘Tab only for a focused, full-screen desktop in front', () => {
    const native = fakeSwitch()
    const gate = hotkeyGate(native, fakeMark())
    gate.update({ ...everything, fullScreen: false })
    gate.update({ ...everything, focused: false })
    gate.update({ ...everything, desktopHoldsKeyboard: false })
    expect(native.calls).toEqual([])
    gate.update(everything)
    expect(native.calls).toEqual([false])
  })

  it('gives it back when any of the three ends, and says each change once', () => {
    const native = fakeSwitch()
    const gate = hotkeyGate(native, fakeMark())
    gate.update(everything)
    gate.update(everything)
    // A three-finger swipe to another space.
    gate.update({ ...everything, focused: false })
    gate.update({ ...everything, focused: false })
    expect(native.calls).toEqual([false, true])
  })

  it('restores on the way out, and not when there is nothing to restore', () => {
    const native = fakeSwitch()
    const gate = hotkeyGate(native, fakeMark())
    gate.restore()
    expect(native.calls).toEqual([])
    gate.update(everything)
    gate.restore()
    expect(native.calls).toEqual([false, true])
  })

  it('tries again after a refusal instead of believing it worked', () => {
    const native = fakeSwitch(false)
    const mark = fakeMark()
    const gate = hotkeyGate(native, mark)
    gate.update(everything)
    gate.update(everything)
    expect(native.calls).toEqual([false, false])
    expect(mark.present).toBe(false)
  })

  it('keeps a mark on disk for exactly as long as ⌘Tab is taken', () => {
    const mark = fakeMark()
    const gate = hotkeyGate(fakeSwitch(), mark)
    gate.update(everything)
    expect(mark.present).toBe(true)
    gate.update({ ...everything, fullScreen: false })
    expect(mark.present).toBe(false)
  })

  it('gives ⌘Tab back at start when a crashed run left it taken', () => {
    const native = fakeSwitch()
    const mark = fakeMark(true)
    hotkeyGate(native, mark)
    expect(native.calls).toEqual([true])
    expect(mark.present).toBe(false)
  })
})
