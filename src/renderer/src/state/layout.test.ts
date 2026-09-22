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
