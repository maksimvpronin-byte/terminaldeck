// @vitest-environment jsdom
import { it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStore } from '../state/store'
import { useZoom } from './useShortcuts'
import { makeLeaf } from '../state/paneTree'
import type { SessionProfile } from '../../../shared/types'

it('handles a failed save when zooming a host with its own font size', async () => {
  const error = new Error('Disk full')
  const save = vi.fn().mockRejectedValue(error)
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const leaf = makeLeaf('host', { kind: 'session', sessionId: 'host' })
  const previous = useStore.getState()
  useStore.setState({
    sessions: [{ id: 'host', fontSize: 15 } as SessionProfile],
    workspaces: [
      {
        id: 'w',
        title: 'w',
        activeTabId: 'tab',
        tabs: [{ id: 'tab', title: 'tab', root: leaf, activePaneId: leaf.id }]
      }
    ],
    activeWorkspaceId: 'w',
    upsertSession: save
  })
  let zoom: (direction: 'in' | 'out' | 'reset') => void = () => undefined
  const originalUi = window.td.ui
  window.td.ui = {
    ...originalUi,
    onZoom: (callback) => {
      zoom = callback
      return () => undefined
    }
  }
  const hook = renderHook(() => useZoom())
  try {
    await act(async () => zoom('in'))
    expect(save).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[zoom] could not save the host font size', error)
  } finally {
    hook.unmount()
    window.td.ui = originalUi
    useStore.setState(previous)
    log.mockRestore()
  }
})
