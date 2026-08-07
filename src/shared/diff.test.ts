import { describe, it, expect } from 'vitest'
import { collapseUnchanged, diffLines } from './diff'

const texts = (result: ReturnType<typeof diffLines>): string[] =>
  result.lines.map((l) => `${l.kind === 'same' ? ' ' : l.kind === 'added' ? '+' : '-'}${l.text}`)

describe('diffLines', () => {
  it('reports nothing for identical text', () => {
    const result = diffLines('a\nb\nc\n', 'a\nb\nc\n')
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
    expect(result.onlyLineEndings).toBe(false)
    expect(result.lines).toHaveLength(3)
  })

  it('does not invent a trailing empty line', () => {
    expect(diffLines('a\n', 'a\n').lines).toHaveLength(1)
    expect(diffLines('a', 'a').lines).toHaveLength(1)
  })

  it('calls out a pure insertion', () => {
    const result = diffLines('a\nc\n', 'a\nb\nc\n')
    expect(texts(result)).toEqual([' a', '+b', ' c'])
    expect(result.added).toBe(1)
    expect(result.removed).toBe(0)
  })

  it('calls out a pure deletion', () => {
    const result = diffLines('a\nb\nc\n', 'a\nc\n')
    expect(texts(result)).toEqual([' a', '-b', ' c'])
    expect(result.removed).toBe(1)
    expect(result.added).toBe(0)
  })

  it('shows a changed line as a removal and an addition', () => {
    const result = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    expect(texts(result)).toEqual([' a', '-b', '+B', ' c'])
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
  })

  it('numbers the lines on the side they belong to', () => {
    const result = diffLines('a\nb\nc\n', 'a\nB\nc\n')
    const removedLine = result.lines.find((l) => l.kind === 'removed')
    const addedLine = result.lines.find((l) => l.kind === 'added')
    expect(removedLine).toMatchObject({ leftNo: 2 })
    expect(addedLine).toMatchObject({ rightNo: 2 })
    expect(result.lines[2]).toMatchObject({ kind: 'added' })
    expect(result.lines[3]).toMatchObject({ kind: 'same', leftNo: 3, rightNo: 3 })
  })

  it('handles an empty side', () => {
    expect(diffLines('', 'a\nb\n').added).toBe(2)
    expect(diffLines('a\nb\n', '').removed).toBe(2)
  })

  it('handles two files with nothing in common', () => {
    const result = diffLines('a\nb\n', 'x\ny\n')
    expect(result.added).toBe(2)
    expect(result.removed).toBe(2)
  })

  it('reports a CRLF-only difference as exactly that, not a rewrite', () => {
    // Otherwise a file edited on Windows shows as every line changed.
    const result = diffLines('a\r\nb\r\n', 'a\nb\n')
    expect(result.onlyLineEndings).toBe(true)
    expect(result.added).toBe(0)
    expect(result.removed).toBe(0)
  })

  it('does not claim a line-ending difference when the text really differs', () => {
    expect(diffLines('a\r\nb\r\n', 'a\nB\n').onlyLineEndings).toBe(false)
  })

  it('keeps a change in the middle of a large file cheap and precise', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`)
    const changed = [...big]
    changed[2500] = 'line 2500 changed'
    const result = diffLines(big.join('\n'), changed.join('\n'))
    expect(result.coarse).toBe(false)
    expect(result.added).toBe(1)
    expect(result.removed).toBe(1)
  })
})

describe('collapseUnchanged', () => {
  const result = diffLines(
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
    Array.from({ length: 40 }, (_, i) => (i === 20 ? 'changed' : `line ${i}`)).join('\n')
  )

  it('folds away runs far from any change', () => {
    const rows = collapseUnchanged(result.lines, 3)
    const gaps = rows.filter((r) => r.kind === 'gap')
    expect(gaps.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(result.lines.length)
  })

  it('keeps the requested context around each change', () => {
    const rows = collapseUnchanged(result.lines, 3)
    const shown = rows.filter((r) => r.kind === 'line')
    // Three before, the removal and the addition, three after.
    expect(shown).toHaveLength(8)
  })

  it('folds nothing when everything changed', () => {
    const all = diffLines('a\nb\n', 'x\ny\n')
    expect(collapseUnchanged(all.lines, 3).every((r) => r.kind === 'line')).toBe(true)
  })
})
