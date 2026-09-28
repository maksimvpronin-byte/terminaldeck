import { describe, expect, it } from 'vitest'
import { globFor, isGlob, nameMatcher } from './fileSearch'

describe('nameMatcher', () => {
  it('matches everything when the query is blank', () => {
    expect(nameMatcher('   ')).toBeNull()
  })

  it('finds a word anywhere in a name, ignoring case', () => {
    const match = nameMatcher('Log')!
    expect(match('catalog.txt')).toBe(true)
    expect(match('nginx.LOG')).toBe(true)
    expect(match('readme')).toBe(false)
  })

  it('treats * and ? as a glob over the whole name', () => {
    const match = nameMatcher('*.log')!
    expect(match('error.log')).toBe(true)
    expect(match('catalog.txt')).toBe(false)
    expect(match('error.log.1')).toBe(false)
    expect(nameMatcher('a?c')!('abc')).toBe(true)
    expect(nameMatcher('a?c')!('abbc')).toBe(false)
  })

  it('does not read regular-expression characters as pattern syntax', () => {
    expect(nameMatcher('*(1).txt')!('copy (1).txt')).toBe(true)
    expect(nameMatcher('*(1).txt')!('copy 1.txt')).toBe(false)
    expect(nameMatcher('a.b')!('axb')).toBe(false)
  })
})

describe('globFor', () => {
  it('wraps a word so find matches it inside names', () => {
    expect(globFor(' conf ')).toBe('*conf*')
    expect(isGlob('conf')).toBe(false)
  })

  it('passes a glob through unchanged', () => {
    expect(globFor('*.yml')).toBe('*.yml')
  })

  it('escapes what find would read as a bracket expression', () => {
    expect(globFor('a[1]')).toBe('*a\\[1\\]*')
  })
})
