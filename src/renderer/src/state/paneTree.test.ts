import { describe, it, expect } from 'vitest'
import {
  makeLeaf,
  mapPane,
  findPane,
  removePane,
  splitLeaf,
  setSizes,
  setAllBroadcast,
  collectLeaves,
  collectConnectionIds,
  collectBroadcastTargets,
  gridOf,
  type PaneNode,
  type LeafNode
} from './paneTree'

function leaf(title: string): LeafNode {
  return makeLeaf(title, { kind: 'session', sessionId: `s-${title}` })
}

describe('splitLeaf', () => {
  it('replaces the leaf with a split holding both panes', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    expect(root.type).toBe('split')
    expect(collectLeaves(root).map((l) => l.title)).toEqual(['a', 'b'])
  })

  it('honours "before" by placing the new pane first', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'before', b)!
    expect(collectLeaves(root).map((l) => l.title)).toEqual(['b', 'a'])
  })

  it('splits a nested leaf without disturbing its siblings', () => {
    const a = leaf('a')
    const b = leaf('b')
    const c = leaf('c')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    const nested = splitLeaf(root, b.id, 'col', 'after', c)!
    expect(collectLeaves(nested).map((l) => l.title)).toEqual(['a', 'b', 'c'])
  })

  it('returns null for an unknown pane id', () => {
    expect(splitLeaf(leaf('a'), 'nope', 'row', 'after', leaf('b'))).toBeNull()
  })
})

describe('removePane', () => {
  it('returns null when the only leaf is removed', () => {
    const a = leaf('a')
    expect(removePane(a, a.id)).toBeNull()
  })

  it('collapses the split so the sibling takes its place', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    const after = removePane(root, b.id)!
    expect(after.type).toBe('leaf')
    expect((after as LeafNode).title).toBe('a')
  })

  it('leaves the tree untouched for an unknown id', () => {
    const a = leaf('a')
    const root = splitLeaf(a, a.id, 'row', 'after', leaf('b'))!
    expect(collectLeaves(removePane(root, 'nope')!)).toHaveLength(2)
  })

  it('keeps remaining panes when removing from a deep tree', () => {
    const a = leaf('a')
    const b = leaf('b')
    const c = leaf('c')
    const root = splitLeaf(splitLeaf(a, a.id, 'row', 'after', b)!, b.id, 'col', 'after', c)!
    const after = removePane(root, b.id)!
    expect(collectLeaves(after).map((l) => l.title)).toEqual(['a', 'c'])
  })
})

describe('mapPane', () => {
  it('updates only the addressed leaf', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    const updated = mapPane(root, b.id, (l) => ({ ...l, sftpOpen: true }))
    const leaves = collectLeaves(updated)
    expect(leaves.find((l) => l.id === b.id)!.sftpOpen).toBe(true)
    expect(leaves.find((l) => l.id === a.id)!.sftpOpen).toBe(false)
  })

  it('ignores a split id', () => {
    const a = leaf('a')
    const root = splitLeaf(a, a.id, 'row', 'after', leaf('b'))! as Extract<
      PaneNode,
      { type: 'split' }
    >
    expect(mapPane(root, root.id, (l) => ({ ...l, sftpOpen: true }))).toEqual(root)
  })
})

describe('connection collection', () => {
  it('gathers only connected panes', () => {
    const a = { ...leaf('a'), connectionId: 'c1' }
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    expect(collectConnectionIds(root)).toEqual(['c1'])
  })

  it('excludes panes opted out of broadcast', () => {
    const a = { ...leaf('a'), connectionId: 'c1' }
    const b = { ...leaf('b'), connectionId: 'c2', broadcastEnabled: false }
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    expect(collectConnectionIds(root).sort()).toEqual(['c1', 'c2'])
    expect(collectBroadcastTargets(root)).toEqual(['c1'])
  })

  it('setAllBroadcast reaches every leaf', () => {
    const a = { ...leaf('a'), connectionId: 'c1' }
    const b = { ...leaf('b'), connectionId: 'c2' }
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    expect(collectBroadcastTargets(setAllBroadcast(root, false))).toEqual([])
    expect(collectBroadcastTargets(setAllBroadcast(root, true)).sort()).toEqual(['c1', 'c2'])
  })
})

describe('findPane and setSizes', () => {
  it('finds nested leaves and splits', () => {
    const a = leaf('a')
    const b = leaf('b')
    const root = splitLeaf(a, a.id, 'row', 'after', b)!
    expect(findPane(root, b.id)?.id).toBe(b.id)
    expect(findPane(root, 'missing')).toBeUndefined()
    expect(findPane(null, a.id)).toBeUndefined()
  })

  it('resizes the addressed split only', () => {
    const a = leaf('a')
    const root = splitLeaf(a, a.id, 'row', 'after', leaf('b'))! as Extract<
      PaneNode,
      { type: 'split' }
    >
    const resized = setSizes(root, root.id, [70, 30]) as Extract<PaneNode, { type: 'split' }>
    expect(resized.sizes).toEqual([70, 30])
  })
})

describe('gridOf', () => {
  /** Each pane's title with its place and size, as fractions of the tab. */
  function cells(
    node: PaneNode,
    x = 0,
    y = 0,
    w = 1,
    h = 1
  ): { title: string; x: number; y: number; w: number; h: number }[] {
    if (node.type === 'leaf') return [{ title: node.title, x, y, w, h }]
    const [a, b] = node.sizes.map((size) => size / 100)
    return node.dir === 'row'
      ? [
          ...cells(node.children[0], x, y, w * a, h),
          ...cells(node.children[1], x + w * a, y, w * b, h)
        ]
      : [
          ...cells(node.children[0], x, y, w, h * a),
          ...cells(node.children[1], x, y + h * a, w, h * b)
        ]
  }
  /** The titles row by row, top to bottom. */
  function rows(node: PaneNode): string[][] {
    const byRow = new Map<number, string[]>()
    for (const cell of cells(node)) {
      const top = Math.round(cell.y * 1000)
      byRow.set(top, [...(byRow.get(top) ?? []), cell.title])
    }
    return [...byRow.entries()].sort(([a], [b]) => a - b).map(([, titles]) => titles)
  }
  const panes = (n: number): [LeafNode, ...LeafNode[]] =>
    Array.from({ length: n }, (_, i) => leaf(String(i + 1))) as [LeafNode, ...LeafNode[]]

  it('lays four panes out two by two, not as a spiral', () => {
    const grid = gridOf(panes(4))
    expect(rows(grid)).toEqual([
      ['1', '2'],
      ['3', '4']
    ])
    for (const cell of cells(grid)) {
      expect(cell.w).toBeCloseTo(0.5)
      expect(cell.h).toBeCloseTo(0.5)
    }
  })

  it('fills rows left to right, top to bottom, the spare panes going to the top', () => {
    expect(rows(gridOf(panes(1)))).toEqual([['1']])
    expect(rows(gridOf(panes(2)))).toEqual([['1', '2']])
    expect(rows(gridOf(panes(3)))).toEqual([['1', '2'], ['3']])
    expect(rows(gridOf(panes(5)))).toEqual([
      ['1', '2', '3'],
      ['4', '5']
    ])
    expect(rows(gridOf(panes(6)))).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6']
    ])
    expect(rows(gridOf(panes(7)))).toEqual([
      ['1', '2', '3'],
      ['4', '5'],
      ['6', '7']
    ])
    expect(rows(gridOf(panes(9)))).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9']
    ])
  })

  it('gives every row an equal height and every pane in a row an equal width', () => {
    const grid = gridOf(panes(7))
    for (const cell of cells(grid)) {
      expect(cell.h).toBeCloseTo(1 / 3)
      expect(cell.w).toBeCloseTo(cell.title <= '3' ? 1 / 3 : 1 / 2)
    }
  })
})
