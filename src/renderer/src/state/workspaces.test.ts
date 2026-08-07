import { describe, it, expect } from 'vitest'
import { makeLeaf } from './paneTree'
import { migrateV1 } from './layout'
import {
  activeTab,
  activeWorkspace,
  allTabs,
  findTab,
  mapTab,
  workspaceHasActivity,
  workspaceOfTab
} from './workspaces'
import type { Workspace, WorkspaceTab } from './slices/types'

function tab(id: string, title = id): WorkspaceTab {
  const leaf = makeLeaf(title, { kind: 'session', sessionId: `s-${id}` })
  return { id, title, root: leaf, activePaneId: leaf.id }
}

function view(): { workspaces: Workspace[]; activeWorkspaceId: string | null } {
  return {
    workspaces: [
      { id: 'w1', title: 'Prod', tabs: [tab('a'), tab('b')], activeTabId: 'b' },
      { id: 'w2', title: 'Staging', tabs: [tab('c')], activeTabId: 'c' },
      { id: 'w3', title: 'Empty', tabs: [], activeTabId: null }
    ],
    activeWorkspaceId: 'w1'
  }
}

describe('workspace selectors', () => {
  it('flattens every tab across workspaces', () => {
    expect(allTabs(view()).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('resolves the active workspace and its active tab', () => {
    expect(activeWorkspace(view())?.title).toBe('Prod')
    expect(activeTab(view())?.id).toBe('b')
  })

  it('has no active tab when the active workspace is empty', () => {
    const state = { ...view(), activeWorkspaceId: 'w3' }
    expect(activeWorkspace(state)?.title).toBe('Empty')
    expect(activeTab(state)).toBeUndefined()
  })

  it('has no active tab when the id points at nothing', () => {
    expect(activeTab({ ...view(), activeWorkspaceId: 'gone' })).toBeUndefined()
  })

  it('finds a tab and its owner from anywhere in the app', () => {
    expect(findTab(view(), 'c')?.title).toBe('c')
    expect(workspaceOfTab(view(), 'c')?.id).toBe('w2')
    expect(findTab(view(), 'nope')).toBeUndefined()
    expect(workspaceOfTab(view(), 'nope')).toBeUndefined()
  })
})

describe('mapTab', () => {
  it('rewrites one tab and leaves the rest identical', () => {
    const before = view().workspaces
    const after = mapTab(before, 'a', (t) => ({ ...t, title: 'renamed' }))
    expect(after[0].tabs[0].title).toBe('renamed')
    expect(after[0].tabs[1]).toBe(before[0].tabs[1])
    // Untouched workspaces keep their identity, so React skips re-rendering them.
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })

  it('is a no-op for an unknown tab', () => {
    const before = view().workspaces
    expect(mapTab(before, 'nope', (t) => ({ ...t, title: 'x' }))).toEqual(before)
  })
})

describe('workspaceHasActivity', () => {
  it('is true when any tab has unread output', () => {
    const workspace = view().workspaces[0]
    expect(workspaceHasActivity(workspace)).toBe(false)
    expect(
      workspaceHasActivity({
        ...workspace,
        tabs: [workspace.tabs[0], { ...workspace.tabs[1], hasActivity: true }]
      })
    ).toBe(true)
  })
})

describe('migrateV1', () => {
  it('folds a flat tab list into one workspace', () => {
    const migrated = migrateV1({ version: 1, tabs: [tab('a'), tab('b')], activeTabId: 'b' })
    expect(migrated.workspaces).toHaveLength(1)
    expect(migrated.workspaces[0].tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(migrated.workspaces[0].activeTabId).toBe('b')
    expect(migrated.activeWorkspaceId).toBe(migrated.workspaces[0].id)
  })

  it('falls back to the first tab when the saved active one is gone', () => {
    const migrated = migrateV1({ version: 1, tabs: [tab('a')], activeTabId: 'vanished' })
    expect(migrated.workspaces[0].activeTabId).toBe('a')
  })

  it('produces nothing from an empty or malformed layout', () => {
    expect(migrateV1({ version: 1, tabs: [], activeTabId: null }).workspaces).toEqual([])
    const broken = { version: 1, activeTabId: null } as unknown as Parameters<typeof migrateV1>[0]
    expect(migrateV1(broken).workspaces).toEqual([])
  })
})
