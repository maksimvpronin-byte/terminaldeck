// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { useStore } from '../store'
import { makeLeaf } from '../paneTree'

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
