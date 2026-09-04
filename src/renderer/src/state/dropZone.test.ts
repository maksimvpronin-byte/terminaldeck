import { describe, expect, it } from 'vitest'
import { dropSide, dropZone } from './dropZone'

/** A row twenty-four points tall, as the tree draws them. */
const row = { top: 100, bottom: 124, height: 24 }

describe('dropZone', () => {
  it('takes the top quarter as the gap above', () => {
    expect(dropZone(row, 100)).toBe('before')
    expect(dropZone(row, 105)).toBe('before')
  })

  it('takes the bottom quarter as the gap below', () => {
    expect(dropZone(row, 124)).toBe('after')
    expect(dropZone(row, 119)).toBe('after')
  })

  it('leaves the middle half meaning inside', () => {
    // The half that was the whole row before sorting existed: dropping a folder
    // onto a folder has always meant nesting it, and still does.
    expect(dropZone(row, 106)).toBe('inside')
    expect(dropZone(row, 112)).toBe('inside')
    expect(dropZone(row, 118)).toBe('inside')
  })
})

describe('dropSide', () => {
  it('splits the row down the middle', () => {
    expect(dropSide(row, 111)).toBe('before')
    expect(dropSide(row, 113)).toBe('after')
  })
})
