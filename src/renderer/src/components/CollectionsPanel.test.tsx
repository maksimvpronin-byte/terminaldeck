// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import CollectionsPanel from './CollectionsPanel'
import { useStore } from '../state/store'
import { makeLeaf } from '../state/paneTree'
import type { SessionProfile } from '../../../shared/types'

const web: SessionProfile = {
  id: 'h1',
  name: 'web-1',
  host: '10.0.0.1',
  groupId: null,
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 0,
  updatedAt: 0
}

/**
 * A host of a set that is already open somewhere else. One click shows the
 * copy that is running; a double-click opens another, in its own tab, where
 * the window was — not in the workspace its first click jumped to.
 */
describe('a host opened from a collection', () => {
  function setUp(): void {
    localStorage.clear()
    // Connected: only a live pane counts as the host being open.
    const running = {
      ...makeLeaf('web-1', { kind: 'session', sessionId: 'h1' }),
      connectionId: 'c1'
    }
    const other = makeLeaf('db', { kind: 'session', sessionId: 'h9' })
    useStore.setState({
      sessions: [web],
      collections: [{ id: 'rel', name: 'Release', hostIds: ['h1'], createdAt: 0, updatedAt: 0 }],
      loadCollections: async () => {},
      inventoryTrees: [],
      gitFolderTrees: [],
      activeWorkspaceId: 'here',
      workspaces: [
        {
          id: 'here',
          title: 'here',
          activeTabId: 't-here',
          tabs: [{ id: 't-here', title: 'db', root: other, activePaneId: other.id }]
        },
        {
          id: 'there',
          title: 'there',
          activeTabId: 't-there',
          tabs: [{ id: 't-there', title: 'web-1', root: running, activePaneId: running.id }]
        }
      ]
    })
    render(<CollectionsPanel query="" />)
  }

  it('shows the running copy on one click', () => {
    setUp()
    fireEvent.click(screen.getByText('web-1'), { detail: 1 })
    expect(useStore.getState().activeWorkspaceId).toBe('there')
  })

  it('opens a new tab where the window was on a double-click', () => {
    setUp()
    const row = screen.getByText('web-1')
    fireEvent.click(row, { detail: 1 })
    fireEvent.click(row, { detail: 2 })
    fireEvent.doubleClick(row)

    const state = useStore.getState()
    expect(state.activeWorkspaceId).toBe('here')
    const here = state.workspaces.find((w) => w.id === 'here')!
    expect(here.tabs.map((t) => t.title)).toEqual(['db', 'web-1'])
    expect(here.activeTabId).toBe(here.tabs[1].id)
    // The running copy is left as it was.
    expect(state.workspaces.find((w) => w.id === 'there')!.tabs).toHaveLength(1)
  })
})
