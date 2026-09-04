import { describe, it, expect } from 'vitest'
import { moveRelativeTo, applyOrder } from './ordering'

const list = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }))
const ids = (items: Array<{ id: string }>): string[] => items.map((x) => x.id)

describe('moveRelativeTo', () => {
  it('drops a row into the gap above its target', () => {
    expect(ids(moveRelativeTo(list('a', 'b', 'c'), 'c', 'a', 'before'))).toEqual(['c', 'a', 'b'])
  })

  it('drops a row into the gap below its target', () => {
    expect(ids(moveRelativeTo(list('a', 'b', 'c'), 'a', 'c', 'after'))).toEqual(['b', 'c', 'a'])
  })

  it('counts the target position after the row has left, dragging downwards', () => {
    // Without removing 'a' first, "before c" would land it back where it was.
    expect(ids(moveRelativeTo(list('a', 'b', 'c'), 'a', 'c', 'before'))).toEqual(['b', 'a', 'c'])
  })

  it('drags upwards to the very top', () => {
    expect(ids(moveRelativeTo(list('a', 'b', 'c'), 'b', 'a', 'before'))).toEqual(['b', 'a', 'c'])
  })

  it('leaves the neighbours alone when nothing really moves', () => {
    expect(ids(moveRelativeTo(list('a', 'b', 'c'), 'b', 'a', 'after'))).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op onto itself', () => {
    expect(ids(moveRelativeTo(list('a', 'b'), 'a', 'a', 'before'))).toEqual(['a', 'b'])
  })

  it('is a no-op when either end of the drag is gone', () => {
    expect(ids(moveRelativeTo(list('a', 'b'), 'ghost', 'a', 'before'))).toEqual(['a', 'b'])
    expect(ids(moveRelativeTo(list('a', 'b'), 'a', 'ghost', 'before'))).toEqual(['a', 'b'])
  })

  it('carries the item itself, not just its id', () => {
    const items = [
      { id: 'a', name: 'first' },
      { id: 'b', name: 'second' }
    ]
    expect(moveRelativeTo(items, 'b', 'a', 'before')[0]).toEqual({ id: 'b', name: 'second' })
  })
})

describe('applyOrder', () => {
  it('reorders to match the given ids', () => {
    expect(ids(applyOrder(list('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('keeps ids the caller never mentioned, in their own order, at the end', () => {
    expect(ids(applyOrder(list('a', 'b', 'c', 'd'), ['c']))).toEqual(['c', 'a', 'b', 'd'])
  })

  it('ignores ids that no longer exist', () => {
    expect(ids(applyOrder(list('a', 'b'), ['ghost', 'b', 'a']))).toEqual(['b', 'a'])
  })

  it('never duplicates an item a caller listed twice', () => {
    expect(ids(applyOrder(list('a', 'b'), ['a', 'a', 'b']))).toEqual(['a', 'b'])
  })

  it('leaves an empty order untouched', () => {
    expect(ids(applyOrder(list('a', 'b'), []))).toEqual(['a', 'b'])
  })
})
