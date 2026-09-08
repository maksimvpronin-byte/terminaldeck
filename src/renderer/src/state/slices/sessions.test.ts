// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { useStore } from '../store'
import type { GitFolderTree, SessionGroup } from '../../../../shared/types'

/**
 * What a Sessions folder holds once it stops mirroring a repository.
 *
 * The main process empties it — the hosts were the repository's, and so were
 * the settings kept for them — but this window is holding its own copy of that
 * tree, read once when it opened. Nothing else in a save tells it to look
 * again, so the copy has to be dropped in the same move as the link, or the
 * folder goes on showing hosts that no longer exist anywhere else.
 */

const folder: SessionGroup = {
  id: 'folder',
  name: 'K8S-OFFICE',
  parentId: null,
  git: { repoUrl: 'git@example.com:infra.git', paths: [], includedGroups: ['office'] }
}

const mirrored: GitFolderTree = {
  groupId: 'folder',
  groups: [],
  sessions: [
    {
      id: 'git:folder:h:office-k8s-v001p',
      name: 'office-k8s-v001p',
      host: 'office-k8s-v001p',
      groupId: 'folder',
      tags: [],
      logToFile: false,
      portForwards: [],
      createdAt: 0,
      updatedAt: 0
    }
  ],
  memberships: {}
}

beforeEach(() => {
  useStore.setState({ groups: [folder], sessions: [], gitFolderTrees: [mirrored] })
  // Main has already forgotten the tree by the time the window asks again.
  window.td.gitFolder.list = () => Promise.resolve({ trees: [], overrides: [], repos: [] })
})

describe('untying a folder from its repository', () => {
  it('takes the hosts it was mirroring with it', async () => {
    window.td.store.saveGroup = (group) => Promise.resolve({ ...group } as SessionGroup)

    await useStore.getState().upsertGroup({ ...folder, git: undefined })

    expect(useStore.getState().gitFolderTrees).toEqual([])
  })

  it('leaves them alone while the folder is still linked', async () => {
    window.td.store.saveGroup = (group) => Promise.resolve({ ...group } as SessionGroup)
    const list = vi.fn(() => Promise.resolve({ trees: [], overrides: [], repos: [] }))
    window.td.gitFolder.list = list

    await useStore.getState().upsertGroup({ ...folder, name: 'Renamed' })

    expect(list).not.toHaveBeenCalled()
    expect(useStore.getState().gitFolderTrees).toEqual([mirrored])
  })

  it('drops the tree when the folder itself is deleted', async () => {
    window.td.store.deleteGroup = () => Promise.resolve()

    await useStore.getState().removeGroup('folder')

    expect(useStore.getState().gitFolderTrees).toEqual([])
  })
})
