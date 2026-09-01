import { describe, it, expect } from 'vitest'
import { rdpKeyFor, substituteCommand, unicodeKey } from './rdpScancodes'

describe('rdpKeyFor', () => {
  it('names physical keys, not the letters printed on them', () => {
    // The point of the whole table: a Russian layout sends the same codes as
    // an English one, and the far side applies its own layout.
    expect(rdpKeyFor('KeyD')).toEqual({ code: 0x20 })
    expect(rdpKeyFor('Semicolon')).toEqual({ code: 0x27 })
  })

  it('marks the keys that share a code with the keypad', () => {
    // Unmarked, Home is Numpad7 and an arrow key types a digit.
    expect(rdpKeyFor('Home')).toEqual({ code: 0x47, extended: true })
    expect(rdpKeyFor('Numpad7')).toEqual({ code: 0x47 })
    expect(rdpKeyFor('ArrowUp')).toEqual({ code: 0x48, extended: true })
    expect(rdpKeyFor('Numpad8')).toEqual({ code: 0x48 })
  })

  it('tells the right-hand modifiers from the left', () => {
    // AltGr is the right Alt, and on half the layouts in Europe it is how the
    // alphabet is typed at all.
    expect(rdpKeyFor('AltLeft')).toEqual({ code: 0x38 })
    expect(rdpKeyFor('AltRight')).toEqual({ code: 0x38, extended: true })
    expect(rdpKeyFor('ControlLeft')).toEqual({ code: 0x1d })
    expect(rdpKeyFor('ControlRight')).toEqual({ code: 0x1d, extended: true })
  })

  it('has nothing to say about a key it does not know', () => {
    expect(rdpKeyFor('Lang1')).toBeUndefined()
    expect(rdpKeyFor('')).toBeUndefined()
  })

  it('gives every plain key a code of its own', () => {
    // A duplicate inside either half is a typo that shows up as one key doing
    // another key's job — silently, and only for whoever presses it.
    const plain = [
      'Escape', 'Digit1', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Tab',
      'KeyQ', 'KeyP', 'BracketLeft', 'BracketRight', 'Enter', 'ControlLeft',
      'KeyA', 'KeyL', 'Semicolon', 'Quote', 'Backquote', 'ShiftLeft',
      'Backslash', 'KeyZ', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight',
      'NumpadMultiply', 'AltLeft', 'Space', 'CapsLock', 'F1', 'F12',
      'NumLock', 'ScrollLock', 'Numpad7', 'Numpad0', 'NumpadDecimal',
      'IntlBackslash', 'NumpadEqual', 'IntlRo', 'IntlYen'
    ]
    const codes = plain.map((key) => rdpKeyFor(key)?.code)
    expect(codes.every((code) => code !== undefined)).toBe(true)
    expect(new Set(codes).size).toBe(plain.length)
  })
})

describe('substituteCommand', () => {
  it('sends ⌘ as Ctrl when the host asked for it', () => {
    expect(substituteCommand('MetaLeft', true)).toBe('ControlLeft')
    expect(substituteCommand('MetaRight', true)).toBe('ControlRight')
  })

  it('leaves the letter beside it alone', () => {
    expect(substituteCommand('KeyC', true)).toBe('KeyC')
  })

  it('changes nothing when it was not asked for', () => {
    expect(substituteCommand('MetaLeft', false)).toBe('MetaLeft')
  })
})

describe('unicodeKey', () => {
  it('takes a character no single key produces', () => {
    // What a dead key or an input method leaves behind: there is no scancode
    // for it, so it goes as text or not at all.
    expect(unicodeKey('ü')).toBe('ü'.charCodeAt(0))
    expect(unicodeKey('щ')).toBe('щ'.charCodeAt(0))
  })

  it('refuses what has a key of its own', () => {
    expect(unicodeKey('Enter')).toBeUndefined()
    expect(unicodeKey('ArrowLeft')).toBeUndefined()
    expect(unicodeKey('\n')).toBeUndefined()
    expect(unicodeKey('')).toBeUndefined()
  })
})
