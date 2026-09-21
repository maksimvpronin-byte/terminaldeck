import { describe, expect, it } from 'vitest'
import type { SessionGroup, SessionProfile } from '../../../shared/types'
import { paletteEntries } from './palette'
import type { PaletteSource } from './palette'

/**
 * The address the palette shows, and searches, for a host out of a repository.
 *
 * A login set here on the repository's group is the login a connection uses,
 * so the palette has to show that one — not whatever the repository said.
 */

function host(id: string, groupId: string): SessionProfile {
  return {
    id,
    name: id,
    host: 'example',
    groupId,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0
  }
}

const group: SessionGroup = { id: 'grp', name: 'Servers', parentId: null, username: 'original' }

function source(over: Partial<PaletteSource>): PaletteSource {
  return {
    sessions: [],
    groups: [],
    inventoryTrees: [],
    inventoryOverrides: [],
    gitFolderTrees: [],
    gitFolderOverrides: [],
    ...over
  }
}

describe('palette entries', () => {
  it('shows an inventory host with the login overridden on its group', () => {
    const entries = paletteEntries(
      source({
        inventoryTrees: [
          { sourceId: 'src', groups: [group], sessions: [host('h', 'grp')], memberships: {} }
        ],
        inventoryOverrides: [{ nodeId: 'grp', username: 'override' }]
      })
    )
    expect(entries[0].address).toBe('override@example')
    expect(entries[0].path).toBe('Servers')
  })

  it('shows a mirrored host with the login overridden on its group', () => {
    const folder: SessionGroup = { id: 'folder', name: 'Folder', parentId: null }
    const entries = paletteEntries(
      source({
        groups: [folder],
        gitFolderTrees: [
          {
            groupId: 'folder',
            groups: [{ ...group, parentId: 'folder' }],
            sessions: [host('h', 'grp')],
            memberships: {}
          }
        ],
        gitFolderOverrides: [{ nodeId: 'grp', username: 'override' }]
      })
    )
    expect(entries[0].address).toBe('override@example')
    expect(entries[0].path).toBe('Folder / Servers')
  })

  it('lets a login on the host itself win over the group’s', () => {
    const entries = paletteEntries(
      source({
        inventoryTrees: [
          { sourceId: 'src', groups: [group], sessions: [host('h', 'grp')], memberships: {} }
        ],
        inventoryOverrides: [
          { nodeId: 'grp', username: 'override' },
          { nodeId: 'h', username: 'own' }
        ]
      })
    )
    expect(entries[0].address).toBe('own@example')
  })
})
