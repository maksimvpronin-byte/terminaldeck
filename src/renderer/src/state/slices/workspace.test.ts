// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useStore } from '../store'
import { collectLeaves, makeLeaf } from '../paneTree'

describe('reorderTab', () => {
  function seed(): void {
    const leaf = (id: string): ReturnType<typeof makeLeaf> => ({
      ...makeLeaf(id, { kind: 'session', sessionId: id }),
      id
    })
    const tab = (id: string) => ({ id, title: id, root: leaf(id), activePaneId: id })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        { id: 'w', title: 'work', activeTabId: 'b', tabs: ['a', 'b', 'c'].map(tab) },
        { id: 'x', title: 'other', activeTabId: 'd', tabs: [tab('d')] }
      ]
    })
  }
  const order = (i = 0): string[] => useStore.getState().workspaces[i].tabs.map((t) => t.id)

  it('drops a tab into the gap before or after another, keeping the same tab objects', () => {
    seed()
    const before = useStore.getState().workspaces[0].tabs
    useStore.getState().reorderTab('c', 'a', 'before')
    expect(order()).toEqual(['c', 'a', 'b'])
    useStore.getState().reorderTab('c', 'b', 'after')
    expect(order()).toEqual(['a', 'b', 'c'])
    useStore.getState().reorderTab('a', 'b', 'after')
    expect(order()).toEqual(['b', 'a', 'c'])
    // Same objects, so no panel remounts and no connection drops.
    const after = useStore.getState().workspaces[0].tabs
    expect(new Set(after)).toEqual(new Set(before))
    expect(useStore.getState().workspaces[0].activeTabId).toBe('b')
  })

  it('leaves the state alone for no-op drops and tabs in another workspace', () => {
    seed()
    const workspaces = useStore.getState().workspaces
    useStore.getState().reorderTab('a', 'b', 'before')
    useStore.getState().reorderTab('b', 'b', 'after')
    useStore.getState().reorderTab('d', 'a', 'before')
    useStore.getState().reorderTab('missing', 'a', 'before')
    expect(useStore.getState().workspaces).toBe(workspaces)
  })
})

describe('terminal activity', () => {
  it('notifies once for unread output and never for visible, already marked or missing tabs', () => {
    const root = makeLeaf('host', { kind: 'session', sessionId: 'host' })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        {
          id: 'w',
          title: 'work',
          activeTabId: 'a',
          tabs: [
            { id: 'a', title: 'a', root, activePaneId: root.id },
            { id: 'b', title: 'b', root: { ...root, id: 'other' }, activePaneId: 'other' }
          ]
        }
      ]
    })
    const notified = vi.fn()
    const off = useStore.subscribe(notified)
    const { markActivity } = useStore.getState()
    for (let i = 0; i < 1000; i++) {
      markActivity('a')
      markActivity('missing')
    }
    expect(notified).not.toHaveBeenCalled()
    for (let i = 0; i < 1000; i++) markActivity('b')
    expect(notified).toHaveBeenCalledTimes(1)
    expect(useStore.getState().workspaces[0].tabs[1].hasActivity).toBe(true)
    off()
  })
})

/**
 * Dropping a tab onto a pane took the first pane of it and closed the rest:
 * every other pane of a split tab vanished, and its session was closed.
 */
describe('dropping a split tab onto a pane', () => {
  function seed(): void {
    const leaf = (id: string): ReturnType<typeof makeLeaf> => ({
      ...makeLeaf(id, { kind: 'session', sessionId: id }),
      id,
      connectionId: `conn-${id}`
    })
    useStore.setState({
      activeWorkspaceId: 'w',
      workspaces: [
        {
          id: 'w',
          title: 'work',
          activeTabId: 'target',
          tabs: [
            { id: 'target', title: 'target', root: leaf('t'), activePaneId: 't' },
            {
              id: 'source',
              title: 'source',
              root: {
                type: 'split',
                id: 'split',
                dir: 'row',
                sizes: [30, 70],
                children: [leaf('first'), leaf('second')]
              },
              // Not the first pane: the one in use must stay the one in use.
              activePaneId: 'second'
            }
          ]
        }
      ]
    })
  }

  it('brings every pane, in its layout, and keeps the one in use active', () => {
    seed()
    useStore.getState().mergeTabInto('source', 'target', 't', 'col', 'after')

    const tabs = useStore.getState().workspaces[0].tabs
    expect(tabs.map((t) => t.id)).toEqual(['target'])
    const [target] = tabs
    expect(target.root.type).toBe('split')
    if (target.root.type !== 'split') return
    const moved = target.root.children[1]
    expect(moved.type).toBe('split')
    if (moved.type !== 'split') return
    expect(moved.sizes).toEqual([30, 70])
    const [first, second] = moved.children
    expect([first, second].map((p) => p.type === 'leaf' && p.title)).toEqual(['first', 'second'])
    expect(target.activePaneId).toBe(second.id)
    // New panes, not the old ones still closing: new ids, no borrowed session.
    expect(second.id).not.toBe('second')
    expect(second.type === 'leaf' && second.connectionId).toBeUndefined()
  })

  it('leaves both tabs alone when the pane dropped on is not there', () => {
    seed()
    const before = useStore.getState().workspaces
    useStore.getState().mergeTabInto('source', 'target', 'missing', 'col', 'after')
    expect(useStore.getState().workspaces).toBe(before)
  })
})

/**
 * A collection lends its look to the panes opened from it. Opened as a grid,
 * only the first pane wore it: the rest were split in without it.
 */
describe('a collection opened as a grid', () => {
  it('gives every pane the collection it came from', () => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null })
    useStore.getState().openMany(
      ['a', 'b', 'c'].map((id) => ({
        title: id,
        target: { kind: 'session' as const, sessionId: id },
        viaCollectionId: 'col1'
      })),
      'grid'
    )
    const [tab] = useStore.getState().workspaces[0].tabs
    expect(collectLeaves(tab.root).map((l) => l.viaCollectionId)).toEqual(['col1', 'col1', 'col1'])
  })

  it('keeps the look when a pane of it is split again', () => {
    useStore.setState({ workspaces: [], activeWorkspaceId: null })
    const paneId = useStore
      .getState()
      .openTab('a', { kind: 'session', sessionId: 'a' }, '#abcdef', 'col1')
    const tabId = useStore.getState().workspaces[0].tabs[0].id
    useStore.getState().splitPane(tabId, paneId, 'row')
    const [tab] = useStore.getState().workspaces[0].tabs
    expect(collectLeaves(tab.root).map((l) => [l.color, l.viaCollectionId])).toEqual([
      ['#abcdef', 'col1'],
      ['#abcdef', 'col1']
    ])
  })
})
