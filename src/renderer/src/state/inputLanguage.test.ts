// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { inputLanguage, languageOfKey, languageOfLayout, resetInputLanguage } from './inputLanguage'

describe('telling the language from what the keyboard does', () => {
  it('reads a letter by its alphabet, and nothing else', () => {
    expect(languageOfKey('й')).toBe('ru')
    expect(languageOfKey('Ё')).toBe('ru')
    expect(languageOfKey('q')).toBe('en')
    expect(languageOfKey('1')).toBeNull()
    expect(languageOfKey('Enter')).toBeNull()
    expect(languageOfLayout(new Map([['KeyQ', 'й']]))).toBe('ru')
    expect(languageOfLayout(new Map([['KeyQ', 'q']]))).toBe('en')
    expect(languageOfLayout(new Map([['KeyQ', 'a']]))).toBe('en')
  })
})

describe('off a Mac', () => {
  let layout = 'q'
  beforeEach(() => {
    resetInputLanguage()
    layout = 'q'
    window.td.ui.inputLanguage = async () => null
    Object.defineProperty(navigator, 'keyboard', {
      configurable: true,
      value: { getLayoutMap: async () => new Map([['KeyQ', layout]]) }
    })
  })

  it('reads the keyboard map whenever it is asked, for a desktop about to connect', async () => {
    expect(await inputLanguage()).toBe('en')
    layout = 'й'
    expect(await inputLanguage()).toBe('ru')
  })

  it('says nothing when there is no keyboard map to read', async () => {
    Object.defineProperty(navigator, 'keyboard', { configurable: true, value: undefined })
    expect(await inputLanguage()).toBeNull()
  })
})
