// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useStore } from '../store'
import { makeLeaf } from '../paneTree'

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
