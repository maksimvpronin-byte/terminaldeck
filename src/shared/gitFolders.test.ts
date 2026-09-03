import { describe, expect, it } from 'vitest'
import {
  descendantPaths,
  gitGroupId,
  gitHostId,
  groupPathOf,
  isGitNode,
  pruneTree,
  reconcileSelection
} from './gitFolders'
import type { GitFolderTree, SessionProfile } from './types'

const FOLDER = 'folder1'

function group(path: string, parent: string | null) {
  return { id: gitGroupId(FOLDER, path), name: path.split('/').pop() ?? path, parentId: parent }
}

function host(name: string, groupPath: string): SessionProfile {
  return {
    id: gitHostId(FOLDER, name),
    name,
    host: name,
    groupId: gitGroupId(FOLDER, groupPath),
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0
  }
}

/** all → prod → web, and all → dev; web1 is in prod and in dev. */
function tree(): GitFolderTree {
  return {
    groupId: FOLDER,
    groups: [
      group('all', FOLDER),
      group('all/prod', gitGroupId(FOLDER, 'all')),
      group('all/prod/web', gitGroupId(FOLDER, 'all/prod')),
      group('all/dev', gitGroupId(FOLDER, 'all'))
    ],
    sessions: [host('web1', 'all/prod/web'), host('db1', 'all/prod'), host('dev1', 'all/dev')],
    memberships: {
      [gitHostId(FOLDER, 'web1')]: [
        gitGroupId(FOLDER, 'all/dev'),
        gitGroupId(FOLDER, 'all/prod/web')
      ],
      [gitHostId(FOLDER, 'db1')]: [gitGroupId(FOLDER, 'all/prod')],
      [gitHostId(FOLDER, 'dev1')]: [gitGroupId(FOLDER, 'all/dev')]
    }
  }
}

describe('node ids', () => {
  it('carries the folder and the inventory path', () => {
    expect(groupPathOf(FOLDER, gitGroupId(FOLDER, 'all/prod'))).toBe('all/prod')
    expect(groupPathOf('other', gitGroupId(FOLDER, 'all'))).toBeUndefined()
    expect(isGitNode(gitHostId(FOLDER, 'web1'))).toBe(true)
    expect(isGitNode('nanoid-looking-id')).toBe(false)
  })
})

describe('descendantPaths', () => {
  it('takes the group and everything under it, and no sibling with a shared prefix', () => {
    const all = ['all', 'all/prod', 'all/prod/web', 'all/production', 'all/dev']
    expect(descendantPaths('all/prod', all)).toEqual(['all/prod', 'all/prod/web'])
  })
})

describe('reconcileSelection', () => {
  const repo = ['all', 'all/prod', 'all/prod/web', 'all/dev']

  it('keeps what was chosen and reports what has gone', () => {
    const result = reconcileSelection(repo, {
      included: ['all', 'all/prod', 'all/staging'],
      known: [...repo, 'all/staging']
    })
    expect(result.included).toEqual(['all', 'all/prod'])
    expect(result.removedGroups).toEqual(['all/staging'])
  })

  it('ticks a new group that appeared under a chosen parent, and marks it new', () => {
    const result = reconcileSelection(repo, {
      included: ['all', 'all/prod'],
      known: ['all', 'all/prod']
    })
    expect(result.newPaths).toEqual(['all/prod/web', 'all/dev'])
    // Both sit under a group that was chosen, so both arrive ticked.
    expect(result.included).toEqual(['all', 'all/prod', 'all/prod/web', 'all/dev'])
  })

  it('leaves a subgroup that was unticked on purpose unticked', () => {
    const result = reconcileSelection(repo, {
      included: ['all', 'all/prod'],
      known: repo
    })
    expect(result.newPaths).toEqual([])
    expect(result.included).toEqual(['all', 'all/prod'])
  })

  it('treats everything as new for a folder synced before groups were recorded', () => {
    const result = reconcileSelection(repo, { included: ['all'] })
    expect(result.newPaths).toEqual(['all/prod', 'all/prod/web', 'all/dev'])
  })
})

describe('pruneTree', () => {
  it('keeps only the chosen groups and the hosts they name', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all', 'all/prod'])
    expect(pruned.groups.map((g) => g.name)).toEqual(['all', 'prod'])
    expect(pruned.sessions.map((s) => s.name)).toEqual(['db1'])
  })

  it('hangs a chosen group off the nearest chosen ancestor', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all', 'all/prod/web'])
    const web = pruned.groups.find((g) => g.name === 'web')
    expect(web?.parentId).toBe(gitGroupId(FOLDER, 'all'))
  })

  it('hangs a group with no chosen ancestor off the folder itself', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all/prod/web'])
    expect(pruned.groups.map((g) => g.parentId)).toEqual([FOLDER])
    expect(pruned.sessions.map((s) => s.name)).toEqual(['web1'])
  })

  it('keeps a host claimed by several groups under each chosen one', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all/dev', 'all/prod/web'])
    const web1 = pruned.sessions.find((s) => s.name === 'web1')
    expect(pruned.memberships[web1!.id]).toEqual([
      gitGroupId(FOLDER, 'all/dev'),
      gitGroupId(FOLDER, 'all/prod/web')
    ])
    // Settings come from the last group in Ansible's order, as they did before.
    expect(web1?.groupId).toBe(gitGroupId(FOLDER, 'all/prod/web'))
  })

  it('moves a host to a surviving group when the one it took settings from goes', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all/dev'])
    const web1 = pruned.sessions.find((s) => s.name === 'web1')
    expect(web1?.groupId).toBe(gitGroupId(FOLDER, 'all/dev'))
  })
})
