// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import InventoryTree from './InventoryTree'
import { useStore } from '../state/store'
import type { InventoryTree as Tree, SessionGroup, SessionProfile } from '../../../shared/types'

/**
 * The tree is indexed once per change rather than searched once per row, so
 * the search and the hosts named by several groups are checked against it here.
 */

const root = 'inv:src:root'

function host(id: string, groupId: string): SessionProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    groupId,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0
  }
}

const group = (id: string, parentId: string): SessionGroup => ({ id, name: id, parentId })

function show(tree: Tree, query = ''): void {
  useStore.setState({
    inventorySources: [{ id: 'src', name: 'Repo', repoUrl: 'git@example.com:x.git', paths: [] }],
    inventoryTrees: [tree],
    inventoryOverrides: [],
    inventorySyncing: [],
    inventorySyncErrors: {}
  })
  render(<InventoryTree query={query} />)
}

describe('the inventory tree', () => {
  it('keeps a group whose match is two levels down, and drops the one without', () => {
    show(
      {
        sourceId: 'src',
        groups: [group(root, ''), group('outer', root), group('inner', 'outer'), group('other', root)],
        sessions: [host('deep-db', 'inner'), host('web', 'other')],
        memberships: {}
      },
      'deep'
    )

    // A group row reads "📁 outer", so the name is matched at its end.
    expect(screen.getByText(/ outer$/)).toBeTruthy()
    expect(screen.getByText(/ inner$/)).toBeTruthy()
    expect(screen.getByText('deep-db')).toBeTruthy()
    expect(screen.queryByText(/ other$/)).toBeNull()
    expect(screen.queryByText('web')).toBeNull()
  })

  it('shows a host under every group that names it', () => {
    show({
      sourceId: 'src',
      groups: [group(root, ''), group('a', root), group('b', root)],
      sessions: [host('db1', 'a')],
      memberships: { db1: ['a', 'b'] }
    })

    expect(screen.getAllByText('db1')).toHaveLength(2)
  })
})
