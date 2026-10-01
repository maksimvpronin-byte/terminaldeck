// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { loadLayout, saveLayout } from './layout'
import { makeLeaf, type LeafNode } from './paneTree'
import type { Workspace } from './slices/types'

beforeEach(() => localStorage.clear())

describe('a layout saved and read back', () => {
  function workspace(): Workspace {
    const live = { ...makeLeaf('web', { kind: 'session', sessionId: 'h1' }), connectionId: 'c1' }
    return {
      id: 'w',
      title: 'work',
      activeTabId: 't1',
      tabs: [{ id: 't1', title: 'web', root: live, activePaneId: live.id, hasActivity: true }]
    }
  }

  it('comes back idle, with nothing live in it', () => {
    saveLayout([workspace()], 'w')
    const [tab] = loadLayout().workspaces[0].tabs
    const leaf = tab.root as LeafNode
    expect(leaf.connectionId).toBeUndefined()
    expect(leaf.restored).toBe(true)
  })

  /**
   * A restored pane has printed nothing yet. The dot a tab carried before the
   * restart pointed at output that no longer exists anywhere.
   */
  it('does not mark a tab as having output it has not had', () => {
    saveLayout([workspace()], 'w')
    const [tab] = loadLayout().workspaces[0].tabs
    expect(tab.hasActivity).toBeUndefined()
  })
})

describe('invalid saved layouts', () => {
  const put = (root: unknown) =>
    localStorage.setItem(
      'terminaldeck.layout',
      JSON.stringify({
        version: 2,
        workspaces: [
          {
            id: 'w',
            title: 'work',
            activeTabId: 't',
            tabs: [{ id: 't', title: 'host', root, activePaneId: 'p' }]
          }
        ],
        activeWorkspaceId: 'w'
      })
    )
  it.each([
    null,
    {},
    { type: 'split', id: 'p', children: [] },
    { type: 'leaf', id: 'p', title: 'host', target: null }
  ])('does not restore a broken pane tree %j', (root) => {
    put(root)
    expect(loadLayout().workspaces).toEqual([])
  })
  it('normalizes missing active references and strips stale live handles at read time', () => {
    const root = {
      ...makeLeaf('host', { kind: 'session', sessionId: 'host' }),
      connectionId: 'stale',
      desktopId: 'stale-desktop'
    }
    put(root)
    const stored = JSON.parse(localStorage.getItem('terminaldeck.layout')!)
    stored.activeWorkspaceId = 'missing'
    stored.workspaces[0].activeTabId = 'missing'
    localStorage.setItem('terminaldeck.layout', JSON.stringify(stored))
    const layout = loadLayout()
    expect(layout.activeWorkspaceId).toBe('w')
    expect(layout.workspaces[0].activeTabId).toBe('t')
    expect(layout.workspaces[0].tabs[0].activePaneId).toBe(root.id)
    const restored = layout.workspaces[0].tabs[0].root as LeafNode
    expect(restored.connectionId).toBeUndefined()
    expect(restored.desktopId).toBeUndefined()
    expect(restored.restored).toBe(true)
  })
  it('rejects duplicate ids across workspaces', () => {
    put(makeLeaf('host', { kind: 'session', sessionId: 'host' }))
    const stored = JSON.parse(localStorage.getItem('terminaldeck.layout')!)
    stored.workspaces.push({ ...stored.workspaces[0], id: 'other' })
    localStorage.setItem('terminaldeck.layout', JSON.stringify(stored))
    expect(loadLayout().workspaces).toEqual([])
  })
})
