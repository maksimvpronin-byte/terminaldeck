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
