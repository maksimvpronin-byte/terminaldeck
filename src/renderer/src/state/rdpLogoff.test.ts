// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeLeaf, splitLeaf } from './paneTree'
import { desktopPanesOf, signOutWorkspace } from './rdpLogoff'
import type { AppState, Workspace } from './slices/types'

describe('the desktop panes of a workspace', () => {
  const windows = makeLeaf('win', { kind: 'session', sessionId: 'win' })
  const linux = makeLeaf('linux', { kind: 'session', sessionId: 'linux' })
  const idle = makeLeaf('win2', { kind: 'session', sessionId: 'win2' })
  const quick = makeLeaf('quick', { kind: 'quick', params: {} as never })
  const split = splitLeaf({ ...windows, desktopId: 'rdp-1' }, windows.id, 'row', 'after', linux)!

  const workspace: Workspace = {
    id: 'w',
    title: 'W',
    tabs: [
      { id: 't1', title: 'split', root: split, activePaneId: windows.id },
      { id: 't2', title: 'idle', root: idle, activePaneId: idle.id },
      { id: 't3', title: 'quick', root: quick, activePaneId: quick.id }
    ],
    activeTabId: 't1'
  }
  const protocol = (id: string): 'ssh' | 'rdp' => (id.startsWith('win') ? 'rdp' : 'ssh')

  it('finds desktops in splits and on their own, leaving terminals out', () => {
    expect(desktopPanesOf(workspace, protocol)).toEqual([
      { tabId: 't1', paneId: windows.id, desktopId: 'rdp-1' },
      { tabId: 't2', paneId: idle.id, desktopId: undefined }
    ])
  })
})

/**
 * Closing every pane on a timer reported a locked desktop, or one whose Run
 * dialog is disabled, as signed out — and left it running on its host.
 */
describe('signing a workspace out', () => {
  const win = makeLeaf('win', { kind: 'session', sessionId: 'win' })
  const other = makeLeaf('win-b', { kind: 'session', sessionId: 'win-b' })
  const never = makeLeaf('win-c', { kind: 'session', sessionId: 'win-c' })

  function workspaceWith(): { getState: () => AppState; closed: string[] } {
    const closed: string[] = []
    let tabs = [
      { id: 't1', title: 'a', root: { ...win, desktopId: 'rdp-a' }, activePaneId: win.id },
      { id: 't2', title: 'b', root: { ...other, desktopId: 'rdp-b' }, activePaneId: other.id },
      { id: 't3', title: 'c', root: never, activePaneId: never.id }
    ]
    const state = (): AppState =>
      ({
        workspaces: [{ id: 'w', title: 'W', tabs, activeTabId: 't1' }],
        sessions: ['win', 'win-b', 'win-c'].map((id) => ({ id, host: id, protocol: 'rdp' })),
        inventoryTrees: [],
        gitFolderTrees: [],
        closePane: (tabId: string, paneId: string) => {
          closed.push(paneId)
          tabs = tabs.filter((t) => t.id !== tabId)
        }
      }) as unknown as AppState
    return { getState: state, closed }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes a desktop when its host confirms, and asks about one that did not', async () => {
    vi.useFakeTimers()
    const { getState, closed } = workspaceWith()
    window.td.rdp.desktopSend = vi.fn()
    const ask = vi.fn(() => false)

    const done = signOutWorkspace(getState, 'w', ask, 5000)
    // The pane that never connected has nothing to sign out of.
    expect(closed).toEqual([never.id])
    await vi.advanceTimersByTimeAsync(3000)
    // One host confirms: its pane closes the way a sign-out from inside does.
    getState().closePane('t1', win.id)
    await vi.runAllTimersAsync()
    await done

    expect(ask).toHaveBeenCalledWith(1)
    // Declined: the one that never confirmed is still there to look at.
    expect(closed).toEqual([never.id, win.id])
  })

  it('closes what did not confirm only when told to', async () => {
    vi.useFakeTimers()
    const { getState, closed } = workspaceWith()
    window.td.rdp.desktopSend = vi.fn()

    const done = signOutWorkspace(getState, 'w', () => true, 5000)
    await vi.runAllTimersAsync()
    await done

    expect(closed.sort()).toEqual([never.id, other.id, win.id].sort())
  })

  it('asks nothing when every desktop confirmed', async () => {
    vi.useFakeTimers()
    const { getState } = workspaceWith()
    window.td.rdp.desktopSend = vi.fn()
    const ask = vi.fn(() => true)

    const done = signOutWorkspace(getState, 'w', ask, 5000)
    await vi.advanceTimersByTimeAsync(3000)
    getState().closePane('t1', win.id)
    getState().closePane('t2', other.id)
    await vi.runAllTimersAsync()
    await done

    expect(ask).not.toHaveBeenCalled()
  })
})
