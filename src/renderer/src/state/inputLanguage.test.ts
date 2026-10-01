// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inputLanguage,
  languageOfKey,
  languageOfLayout,
  noteTyped,
  onInputLanguage,
  resetInputLanguage
} from './inputLanguage'

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
    window.td.ui.onInputLanguage = () => () => undefined
    Object.defineProperty(navigator, 'keyboard', {
      configurable: true,
      value: { getLayoutMap: async () => new Map([['KeyQ', layout]]) }
    })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  it('starts from the keyboard map, and hears a letter typed in another language', async () => {
    expect(await inputLanguage()).toBe('en')
    const heard = vi.fn()
    const stop = onInputLanguage(heard)
    await Promise.resolve()
    noteTyped('ж')
    expect(heard).toHaveBeenLastCalledWith('ru')
    noteTyped('ш')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
  })

  it('believes the map when it changes, and not when it only repeats itself', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      expect(await inputLanguage()).toBe('en')
      const heard = vi.fn()
      const stop = onInputLanguage(heard)
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1))
      // A letter proves Russian; the map saying English again changes nothing.
      noteTyped('я')
      await vi.advanceTimersByTimeAsync(400)
      expect(heard).toHaveBeenLastCalledWith('ru')
      // The map moving is news, and is heard.
      layout = 'й'
      await vi.advanceTimersByTimeAsync(400)
      layout = 'q'
      await vi.advanceTimersByTimeAsync(400)
      expect(heard).toHaveBeenLastCalledWith('en')
      stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
