import { describe, expect, it } from 'vitest'
import { resolveAuth } from './authResolution'
import {
  descendantPaths,
  gitFolderLayout,
  gitGroupId,
  gitHostId,
  groupPathOf,
  hostsWithChildren,
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

  it('keeps what a dropped ancestor says about logging in', () => {
    // group_vars/all.yml saying ansible_user: deploy, with only web ticked
    const full = tree()
    full.groups = full.groups.map((g) =>
      g.name === 'all'
        ? { ...g, username: 'deploy', port: 2222 }
        : g.name === 'prod'
          ? { ...g, port: 22, username: '' }
          : g
    )
    const pruned = pruneTree(FOLDER, full, ['all/prod/web'])
    const web = pruned.groups[0]
    expect(web).toMatchObject({ name: 'web', parentId: FOLDER })
    // Frozen rather than folded in: web says nothing itself, and reads all and prod.
    expect(web.username).toBeUndefined()
    expect(resolveAuth(web, web.parentId, pruned.groups)).toMatchObject({
      username: 'deploy',
      port: 22
    })
  })

  /**
   * prod ticked with the hosts of its children: web's hosts arrive through prod
   * and are placed there, but what web said about logging in is theirs still.
   */
  /** How a pruned host will connect, as resolution reads it. */
  function connectsWith(
    pruned: ReturnType<typeof pruneTree>,
    name: string,
    protocol: 'ssh' | 'rdp' = 'ssh'
  ): { username: string; port: number } {
    const host = pruned.sessions.find((s) => s.name === name)!
    const { username, port } = resolveAuth(host, host.groupId ?? null, pruned.groups, { protocol })
    return { username, port }
  }

  /**
   * prod ticked with the hosts of its children: web's hosts arrive through prod
   * and are placed there, but what web said about logging in is theirs still.
   */
  it('keeps what a host’s own dropped group said when it arrives through a parent', () => {
    const full = tree()
    full.groups = full.groups.map((g) =>
      g.name === 'web'
        ? { ...g, username: 'deploy', port: 2222 }
        : g.name === 'prod'
          ? { ...g, username: 'root', port: 22 }
          : g
    )
    const pruned = pruneTree(FOLDER, full, ['all', 'all/prod'], true)
    expect(pruned.sessions.find((s) => s.name === 'web1')?.groupId).toBe(
      gitGroupId(FOLDER, 'all/prod')
    )
    expect(connectsWith(pruned, 'web1')).toEqual({ username: 'deploy', port: 2222 })
    // A host that prod names itself takes prod's settings as before.
    expect(connectsWith(pruned, 'db1')).toEqual({ username: 'root', port: 22 })
  })

  /**
   * A group's port is ansible_port — WinRM's 5985 — and a desktop is not dialled
   * on it, whether the repository says the host is a desktop or it is switched
   * to one here afterwards.
   */
  it('carries a dropped group so that a desktop still reads it as a desktop', () => {
    const full = tree()
    full.groups = full.groups.map((g) =>
      g.name === 'web' ? { ...g, username: 'EXAMPLE\\admin', port: 5985 } : g
    )
    const pruned = pruneTree(FOLDER, full, ['all', 'all/prod'], true)
    expect(connectsWith(pruned, 'web1', 'rdp')).toEqual({ username: 'EXAMPLE\\admin', port: 3389 })
    expect(connectsWith(pruned, 'web1', 'ssh')).toEqual({ username: 'EXAMPLE\\admin', port: 5985 })
  })

  /*
   * Folded into z, which takes all's place, all's root:22 counted as z's own
   * and beat a's deploy:2222, which Ansible reads after all.
   */
  it('reads a dropped all in its own place, below the groups kept', () => {
    const id = (path: string) => gitGroupId(FOLDER, path)
    const h = {
      ...host('h', 'all/z'),
      groupOrder: [id('all'), id('all/a'), id('all/z')],
      memberOf: [id('all/a'), id('all/z')]
    }
    const full: GitFolderTree = {
      groupId: FOLDER,
      groups: [
        { ...group('all', FOLDER), username: 'root', port: 22 },
        { ...group('all/a', id('all')), username: 'deploy', port: 2222 },
        group('all/z', id('all'))
      ],
      sessions: [h],
      memberships: { [h.id]: [id('all/a'), id('all/z')] }
    }
    expect(connectsWith(pruneTree(FOLDER, full, ['all/a', 'all/z']), 'h')).toEqual({
      username: 'deploy',
      port: 2222
    })
  })

  it('lets the host’s own values win over a dropped group’s', () => {
    const full = tree()
    full.groups = full.groups.map((g) => (g.name === 'web' ? { ...g, username: 'deploy' } : g))
    full.sessions = full.sessions.map((h) => (h.name === 'web1' ? { ...h, username: 'me' } : h))
    const pruned = pruneTree(FOLDER, full, ['all', 'all/prod'], true)
    expect(connectsWith(pruned, 'web1').username).toBe('me')
  })

  it('lets a kept group and a kept ancestor say it themselves', () => {
    const full = tree()
    full.groups = full.groups.map((g) =>
      g.name === 'all'
        ? { ...g, username: 'deploy' }
        : g.name === 'web'
          ? { ...g, username: 'www' }
          : g
    )
    const pruned = pruneTree(FOLDER, full, ['all', 'all/prod/web'])
    expect(pruned.groups.find((g) => g.name === 'web')?.username).toBe('www')
    // all is still in the tree, so prod's absence folds nothing from it
    const viaAll = pruneTree(FOLDER, full, ['all', 'all/dev'])
    expect(viaAll.groups.find((g) => g.name === 'dev')?.username).toBeUndefined()
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

/**
 * A kubespray-shaped inventory: hosts stated once under their own group, and
 * the grouping groups referring to those by name.
 *
 *   all → cp (cp1), all → worker (w1), all → node → worker,
 *   all → cluster → cp, all → cluster → node
 */
function referenced(): GitFolderTree {
  const id = (p: string): string => gitGroupId(FOLDER, p)
  return {
    groupId: FOLDER,
    groups: [
      group('all', FOLDER),
      group('all/cp', id('all')),
      group('all/worker', id('all')),
      group('all/node', id('all')),
      group('all/node/worker', id('all/node')),
      group('all/cluster', id('all')),
      group('all/cluster/cp', id('all/cluster')),
      group('all/cluster/node', id('all/cluster'))
    ],
    sessions: [host('cp1', 'all/cp'), host('w1', 'all/worker')],
    memberships: {
      [gitHostId(FOLDER, 'cp1')]: [id('all/cp')],
      [gitHostId(FOLDER, 'w1')]: [id('all/worker')]
    }
  }
}

describe('hostsWithChildren', () => {
  it('counts a child by name, wherever its hosts are listed', () => {
    const counted = hostsWithChildren(referenced())
    const names = (path: string): string[] =>
      [...counted.get(gitGroupId(FOLDER, path))!].map((h) => h.split(':h:')[1]).sort()

    expect(names('all/node')).toEqual(['w1'])
    expect(names('all/node/worker')).toEqual(['w1'])
    // Two levels down, through a reference to a reference.
    expect(names('all/cluster')).toEqual(['cp1', 'w1'])
    expect(names('all/cluster/node')).toEqual(['w1'])
    expect(names('all')).toEqual(['cp1', 'w1'])
  })

  it('stops at a group that contains itself', () => {
    const looped = referenced()
    looped.groups.push(group('all/cp/cluster', gitGroupId(FOLDER, 'all/cp')))
    const counted = hostsWithChildren(looped)
    expect(counted.get(gitGroupId(FOLDER, 'all/cp'))?.size).toBe(2)
  })
})

describe('pruneTree with the hosts of child groups', () => {
  it('brings nothing for a grouping group alone when it is off', () => {
    const pruned = pruneTree(FOLDER, referenced(), ['all/cluster'])
    expect(pruned.sessions).toEqual([])
  })

  it('brings every host beneath a grouping group when it is on', () => {
    const pruned = pruneTree(FOLDER, referenced(), ['all/cluster'], true)
    expect(pruned.sessions.map((s) => s.name)).toEqual(['cp1', 'w1'])
    expect(pruned.sessions.every((s) => s.groupId === gitGroupId(FOLDER, 'all/cluster'))).toBe(true)
  })

  /*
   * h is in web and in api, under prod and under stage; with only the parents
   * ticked it arrives through both. Resolution walks up from the groups that
   * hold a host, and those it named were gone: prod's login never reached it.
   */
  it('walks up from the groups that hold a host now', () => {
    const id = (path: string) => gitGroupId(FOLDER, path)
    const full: GitFolderTree = {
      groupId: FOLDER,
      groups: [
        group('all', FOLDER),
        { ...group('all/prod', id('all')), username: 'deploy' },
        group('all/stage', id('all')),
        group('all/prod/web', id('all/prod')),
        group('all/stage/api', id('all/stage'))
      ],
      sessions: [
        {
          ...host('h', 'all/prod/web'),
          groupOrder: ['all', 'all/prod', 'all/stage', 'all/stage/api', 'all/prod/web'].map(id),
          memberOf: [id('all/stage/api'), id('all/prod/web')]
        }
      ],
      memberships: { [gitHostId(FOLDER, 'h')]: [id('all/stage/api'), id('all/prod/web')] }
    }
    const pruned = pruneTree(FOLDER, full, ['all', 'all/prod', 'all/stage'], true)
    const h = pruned.sessions[0]
    expect(resolveAuth(h, h.groupId ?? null, pruned.groups).username).toBe('deploy')
  })

  /* a, of a file without all, sits below another file's all, which is kept. */
  it('keeps another file’s all above a top group it holds', () => {
    const all = { ...group('all', FOLDER), username: 'all-user' }
    const a = { ...group('a', FOLDER), allId: all.id }
    const h = { ...host('h', 'a'), groupOrder: [all.id, a.id] }
    const full: GitFolderTree = {
      groupId: FOLDER,
      groups: [all, a],
      sessions: [h],
      memberships: { [h.id]: [a.id] }
    }
    const pruned = pruneTree(FOLDER, full, ['all', 'a'])
    const kept = pruned.sessions[0]
    expect(resolveAuth(kept, kept.groupId ?? null, pruned.groups).username).toBe('all-user')
  })

  it('keeps settings from the group a host names, and lists it under both', () => {
    const pruned = pruneTree(FOLDER, referenced(), ['all/cluster', 'all/worker'], true)
    const w1 = pruned.sessions.find((s) => s.name === 'w1')!
    expect(w1.groupId).toBe(gitGroupId(FOLDER, 'all/worker'))
    expect(pruned.memberships[w1.id]).toEqual([
      gitGroupId(FOLDER, 'all/worker'),
      gitGroupId(FOLDER, 'all/cluster')
    ])
  })
})

describe('Git folder layout', () => {
  const folder = {
    id: FOLDER,
    name: 'Infra',
    parentId: null,
    git: { repoUrl: 'repo', paths: [], includedGroups: [] }
  }

  it('keeps existing folders flat by default', () => {
    const layout = gitFolderLayout([tree()], [folder])
    expect([...layout.visibleGroupIds]).toEqual([])
    expect([...layout.hostsByGroup.get(FOLDER)!]).toEqual(tree().sessions.map((s) => s.id))
  })

  it('shows selected groups and places shared hosts in each membership', () => {
    const pruned = pruneTree(FOLDER, tree(), ['all/dev', 'all/prod/web'])
    const layout = gitFolderLayout(
      [pruned],
      [{ ...folder, git: { ...folder.git, showGroupFolders: true } }]
    )
    expect([...layout.visibleGroupIds]).toEqual(pruned.groups.map((g) => g.id))
    expect(pruned.groups.every((g) => g.parentId === FOLDER)).toBe(true)
    expect(layout.hostsByGroup.has(FOLDER)).toBe(false)
    expect([...layout.hostsByGroup.get(gitGroupId(FOLDER, 'all/dev'))!]).toEqual([
      gitHostId(FOLDER, 'web1'),
      gitHostId(FOLDER, 'dev1')
    ])
    expect([...layout.hostsByGroup.get(gitGroupId(FOLDER, 'all/prod/web'))!]).toEqual([
      gitHostId(FOLDER, 'web1')
    ])
  })
})
