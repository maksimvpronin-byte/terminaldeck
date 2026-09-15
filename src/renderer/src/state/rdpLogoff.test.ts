import { describe, expect, it } from 'vitest'
import { makeLeaf, splitLeaf } from './paneTree'
import { desktopPanesOf } from './rdpLogoff'
import type { Workspace } from './slices/types'

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
