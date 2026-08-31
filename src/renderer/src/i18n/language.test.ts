import { describe, it, expect } from 'vitest'
import { translate } from './language'

describe('translating a phrase', () => {
  it('uses the dictionary when there is an entry', () => {
    expect(translate('ru', 'Password')).toBe('Пароль')
  })

  /** A half-translated screen shows English, not machine names. */
  it('falls back to the English key when there is not', () => {
    expect(translate('ru', 'Not a phrase anyone has translated')).toBe(
      'Not a phrase anyone has translated'
    )
    expect(translate('en', 'Password')).toBe('Password')
  })

  it('fills placeholders after the lookup, wherever the translation puts them', () => {
    expect(translate('en', 'Version {version} is available.', { version: '0.4.1' })).toBe(
      'Version 0.4.1 is available.'
    )
  })

  it('takes numbers as readily as strings', () => {
    expect(translate('en', 'Downloading update… {percent}%', { percent: 42 })).toBe(
      'Downloading update… 42%'
    )
  })

  /** Visible as `{version}` on screen, which is findable; a hole is not. */
  it('leaves a placeholder alone when nothing was given for it', () => {
    expect(translate('en', 'Version {version} is available.', { other: 'x' })).toBe(
      'Version {version} is available.'
    )
  })

  it('leaves the phrase alone when no values are given at all', () => {
    expect(translate('en', 'Version {version} is available.')).toBe(
      'Version {version} is available.'
    )
  })

  it('fills every occurrence of the same placeholder', () => {
    expect(translate('en', '{name} and {name}', { name: 'x' })).toBe('x and x')
  })
})
