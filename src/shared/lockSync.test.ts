import { describe, expect, it } from 'vitest'
import { isLockKey, lockFlags, SYNC, type LockState } from './lockSync'

/** A keyboard, as the event would report it. */
function keyboard(...on: LockState[]) {
  return (state: LockState): boolean => on.includes(state)
}

describe('lockFlags', () => {
  it('reports nothing on when nothing is on', () => {
    expect(lockFlags(keyboard(), false)).toBe(0)
  })

  it('reports Num Lock when it is on, rather than always off', () => {
    expect(lockFlags(keyboard('NumLock'), false)).toBe(SYNC.numLock)
  })

  it('reports each lock with its own bit', () => {
    expect(lockFlags(keyboard('NumLock', 'CapsLock', 'ScrollLock'), false)).toBe(0x07)
  })

  it('keeps Num Lock on from a Mac, whose keypad always types digits', () => {
    expect(lockFlags(keyboard(), true)).toBe(SYNC.numLock)
    expect(lockFlags(keyboard('CapsLock'), true)).toBe(SYNC.numLock | SYNC.capsLock)
  })
})

describe('isLockKey', () => {
  it('knows the three lock keys and nothing else', () => {
    expect(['NumLock', 'CapsLock', 'ScrollLock'].every(isLockKey)).toBe(true)
    expect(isLockKey('Numpad1')).toBe(false)
    expect(isLockKey('ShiftLeft')).toBe(false)
  })
})
