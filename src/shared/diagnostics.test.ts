import { describe, it, expect } from 'vitest'
import { describeInput, describeKeyCode, describeModifiers } from './diagnostics'

const none = { ctrl: false, shift: false, alt: false, meta: false }

describe('describeInput', () => {
  it('counts text and names control characters', () => {
    expect(describeInput('asdasd\x04\r')).toBe('6 chars ^D ^M')
  })

  it('never contains the text itself', () => {
    expect(describeInput('hunter2\r')).not.toContain('hunter')
  })

  it('names escape and DEL', () => {
    expect(describeInput('\x1b[A\x7f')).toBe('ESC 2 chars ^?')
  })

  it('counts characters, not UTF-16 units', () => {
    expect(describeInput('привет😀')).toBe('7 chars')
  })

  it('keeps a long paste to one bounded line', () => {
    const line = describeInput('a\r'.repeat(100))
    expect(line).toContain('(200 in all)')
    expect(line.split(' ').length).toBeLessThan(60)
  })

  it('says nothing for nothing', () => {
    expect(describeInput('')).toBe('')
  })
})

describe('describeKeyCode', () => {
  it('always names modifiers', () => {
    expect(describeKeyCode('ControlLeft', none)).toBe('ControlLeft')
  })

  it('names a key held with Ctrl', () => {
    expect(describeKeyCode('KeyD', { ...none, ctrl: true })).toBe('KeyD')
  })

  it('hides a key typed alone or with Shift', () => {
    expect(describeKeyCode('KeyD', none)).toBe('key')
    expect(describeKeyCode('KeyD', { ...none, shift: true })).toBe('key')
  })
})

describe('describeModifiers', () => {
  it('lists what is held', () => {
    expect(describeModifiers({ ...none, ctrl: true, shift: true })).toBe('Ctrl+Shift')
    expect(describeModifiers(none)).toBe('-')
  })
})
