import { describe, it, expect } from 'vitest'
import { colourOf } from './hostColour'

const groups = [
  { id: 'prod', parentId: null, color: '#f00' },
  { id: 'db', parentId: 'prod' },
  { id: 'loop-a', parentId: 'loop-b' },
  { id: 'loop-b', parentId: 'loop-a' }
]

describe('colourOf', () => {
  it('prefers the item’s own colour', () => {
    expect(colourOf({ color: '#00f' }, 'db', groups)).toBe('#00f')
  })
  it('takes the nearest folder’s colour, however far up', () => {
    expect(colourOf({}, 'db', groups)).toBe('#f00')
  })
  it('is nothing outside any coloured folder, and survives a cycle', () => {
    expect(colourOf({}, null, groups)).toBeUndefined()
    expect(colourOf({}, 'loop-a', groups)).toBeUndefined()
  })
})
