// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { useStore } from '../store'
import type { SessionGroup, SessionProfile, SessionStoreData } from '../../../../shared/types'

/**
 * A drag shows the new order at once and writes it after. When the write fails
 * the tree must go back to what the disk holds, or it goes on showing an order
 * and a group that were never kept — until the application is next started.
 */

function host(id: string, groupId: string): SessionProfile {
  return { id, name: id, host: id, groupId } as SessionProfile
}

const one: SessionGroup = { id: 'one', name: 'One', parentId: null }
const two: SessionGroup = { id: 'two', name: 'Two', parentId: null }
const onDisk: SessionStoreData = {
  version: 1,
  groups: [one, two],
  sessions: [host('a', 'one'), host('b', 'two')]
}

beforeEach(() => {
  useStore.setState({ groups: onDisk.groups, sessions: onDisk.sessions })
  window.td.store.load = () => Promise.resolve(structuredClone(onDisk))
  window.td.store.reorderSessions = () => Promise.resolve()
  window.td.store.reorderGroups = () => Promise.resolve()
})

describe('a drag whose save fails', () => {
  it('puts the hosts back as the disk holds them', async () => {
    window.td.store.saveSession = () => Promise.reject(new Error('disk full'))

    await expect(useStore.getState().reorderSession('a', 'b', 'after')).rejects.toThrow(
      'disk full'
    )

    expect(useStore.getState().sessions).toEqual(onDisk.sessions)
  })

  it('puts the folders back as the disk holds them', async () => {
    window.td.store.reorderGroups = () => Promise.reject(new Error('disk full'))

    await expect(useStore.getState().reorderGroup('one', 'two', 'after')).rejects.toThrow(
      'disk full'
    )

    expect(useStore.getState().groups.map((g) => g.id)).toEqual(['one', 'two'])
  })

  it('keeps the new order when the save succeeds', async () => {
    window.td.store.saveSession = (s) => Promise.resolve(s)

    await useStore.getState().reorderSession('a', 'b', 'after')

    expect(useStore.getState().sessions.map((s) => [s.id, s.groupId])).toEqual([
      ['b', 'two'],
      ['a', 'two']
    ])
  })
})

describe('deleting a selection', () => {
  it('asks main once and drops the hosts from the tree', async () => {
    const calls: string[][] = []
    window.td.store.deleteSessions = (ids) => {
      calls.push(ids)
      return Promise.resolve()
    }

    await useStore.getState().removeSessions(['a', 'b'])

    expect(calls).toEqual([['a', 'b']])
    expect(useStore.getState().sessions).toEqual([])
  })

  it('shows what the disk holds when the delete fails', async () => {
    window.td.store.deleteSessions = () => Promise.reject(new Error('disk full'))
    window.td.store.load = () =>
      Promise.resolve({ ...structuredClone(onDisk), sessions: [host('b', 'two')] })

    await expect(useStore.getState().removeSessions(['a', 'b'])).rejects.toThrow('disk full')

    expect(useStore.getState().sessions.map((s) => s.id)).toEqual(['b'])
  })
})
