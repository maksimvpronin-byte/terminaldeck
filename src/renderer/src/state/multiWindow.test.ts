import { describe, it, expect } from 'vitest'
import { makeLeaf, collectLeaves, type PaneNode } from './paneTree'
import { hostsOf, paneNodeOf, savedPaneOf } from './multiWindow'

const leaf = (id: string, extra: Partial<ReturnType<typeof makeLeaf>> = {}) => ({
  ...makeLeaf(id, { kind: 'session', sessionId: id }, '#123456'),
  ...extra
})
const split = (dir: 'row' | 'col', a: PaneNode, b: PaneNode, sizes: [number, number] = [50, 50]) =>
  ({ type: 'split', id: `${dir}-${Math.random()}`, dir, sizes, children: [a, b] }) as PaneNode

describe('keeping a tab’s panes', () => {
  it('keeps the arrangement and the hosts, and nothing that was live', () => {
    const root = split(
      'col',
      leaf('top', { connectionId: 'c1', sftpOpen: true }),
      split('row', leaf('left'), leaf('right', { desktopId: 'd1' }), [30, 70]),
      [60, 40]
    )
    expect(savedPaneOf(root)).toEqual({
      type: 'split',
      dir: 'col',
      sizes: [60, 40],
      children: [
        { type: 'leaf', sessionId: 'top', title: 'top', color: '#123456', sftpOpen: true },
        {
          type: 'split',
          dir: 'row',
          sizes: [30, 70],
          children: [
            { type: 'leaf', sessionId: 'left', title: 'left', color: '#123456' },
            { type: 'leaf', sessionId: 'right', title: 'right', color: '#123456' }
          ]
        }
      ]
    })
  })

  it('leaves Quick connect panes out, closing the split they leave half empty', () => {
    const quick = makeLeaf('q', {
      kind: 'quick',
      params: { host: 'q', port: 22, username: 'u', authMethod: 'password', password: 'secret' }
    })
    expect(savedPaneOf(split('row', quick, leaf('kept')))).toEqual({
      type: 'leaf',
      sessionId: 'kept',
      title: 'kept',
      color: '#123456'
    })
    expect(savedPaneOf(quick)).toBeNull()
  })

  it('keeps the account and console mode a pane was opened with', () => {
    const pane = makeLeaf('dc', {
      kind: 'session',
      sessionId: 'dc',
      credentialId: 'adm',
      admin: true
    })
    expect(savedPaneOf(pane)).toMatchObject({ credentialId: 'adm', admin: true })
  })
})

describe('opening it again', () => {
  it('builds the same arrangement out of new panes, and lists its hosts in order', () => {
    const saved = savedPaneOf(
      split('col', leaf('a', { monitorOpen: true }), split('row', leaf('b'), leaf('c'), [25, 75]))
    )!
    const root = paneNodeOf(saved)
    expect(savedPaneOf(root)).toEqual(saved)
    const leaves = collectLeaves(root)
    expect(leaves.map((l) => l.target)).toEqual([
      { kind: 'session', sessionId: 'a' },
      { kind: 'session', sessionId: 'b' },
      { kind: 'session', sessionId: 'c' }
    ])
    expect(leaves.every((l) => l.connectionId === undefined && !l.restored)).toBe(true)
    expect(leaves[0].monitorOpen).toBe(true)
    // Every pane its own: opening twice must not share an id between tabs.
    expect(new Set([...leaves, ...collectLeaves(paneNodeOf(saved))].map((l) => l.id)).size).toBe(6)
    expect(hostsOf(saved)).toEqual(['a', 'b', 'c'])
  })
})
