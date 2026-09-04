import { describe, it, expect, beforeAll, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { InventoryOverride, SessionGroup } from '../../shared/types'
import { gitGroupId, gitHostId } from '../../shared/gitFolders'

/**
 * The whole main-side flow against a real repository on disk.
 *
 * A real `git init` rather than a mocked one, because what is being tested is
 * exactly the part that talks to git: a clone, a commit landing on the far side,
 * and a second sync noticing what has left the inventory. Both the checkout and
 * the stores live under a temporary directory that goes at the end.
 */

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-gitfolder-'))
const { sessionStore } = await import('../store/SessionStore')
const { gitFolderStore } = await import('./GitFolderStore')

const FOLDER = 'folder-1'
const repo = join(userData, 'inventory-repo')

/** Secrets are the caller's business; the tests only record who was forgotten. */
const forgotten: string[] = []
const forget = (o: InventoryOverride): void => void forgotten.push(o.nodeId)

function git(...args: string[]): void {
  execFileSync('git', args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  })
}

function writeInventory(body: string): void {
  writeFileSync(join(repo, 'hosts.yml'), body, 'utf8')
  git('add', '-A')
  git('commit', '-m', 'inventory')
}

const BOTH = `
all:
  children:
    prod:
      hosts:
        web1:
          ansible_host: 10.0.0.1
        db1:
          ansible_host: 10.0.0.2
    dev:
      hosts:
        dev1:
          ansible_host: 10.0.1.1
`

const PROD_ONLY = `
all:
  children:
    prod:
      hosts:
        web1:
          ansible_host: 10.0.0.1
`

beforeAll(() => {
  mkdirSync(repo, { recursive: true })
  git('init', '--initial-branch', 'main')
  writeInventory(BOTH)

  const folder: SessionGroup = {
    id: FOLDER,
    name: 'Infra',
    parentId: null,
    username: 'ops',
    git: { repoUrl: repo, paths: ['hosts.yml'], includedGroups: [] }
  }
  sessionStore.saveGroup(folder)

  return () => rmSync(userData, { recursive: true, force: true })
})

const linkNow = (): NonNullable<SessionGroup['git']> =>
  sessionStore.getAll().groups.find((g) => g.id === FOLDER)!.git!

describe('a Sessions folder mirroring a repository', () => {
  it('offers every group of a repository it has never synced, and takes none by itself', async () => {
    const preview = await gitFolderStore.preview(FOLDER)

    expect(preview.groups.map((g) => g.path)).toEqual(['all', 'all/prod', 'all/dev'])
    expect(preview.groups.every((g) => g.isNew)).toBe(true)
    expect(preview.included).toEqual([])
    expect(preview.revision).toMatch(/^[0-9a-f]+$/)
    // Nothing is written until the choice is applied.
    expect(gitFolderStore.treeOf(FOLDER)).toBeUndefined()
  })

  it('takes only the chosen groups, and hangs them under the folder', async () => {
    await gitFolderStore.preview(FOLDER)
    const tree = gitFolderStore.apply(FOLDER, ['all', 'all/prod'], forget)

    expect(tree.groups.map((g) => g.name)).toEqual(['all', 'prod'])
    expect(tree.groups.find((g) => g.name === 'all')?.parentId).toBe(FOLDER)
    expect(tree.sessions.map((s) => s.name).sort()).toEqual(['db1', 'web1'])
    expect(linkNow().includedGroups).toEqual(['all', 'all/prod'])
    expect(linkNow().knownGroups).toEqual(['all', 'all/prod', 'all/dev'])
    expect(linkNow().lastSyncedAt).toBeGreaterThan(0)
  })

  it('resolves a host through the repository groups and on into the folder', () => {
    const host = gitFolderStore.findSession(gitHostId(FOLDER, 'web1'))
    expect(host?.host).toBe('10.0.0.1')
    // The folder is a saved group, so it is not in this list — the chain reaches
    // it through the parent id of the topmost mirrored group.
    expect(gitFolderStore.allGroups().map((g) => g.id)).toContain(gitGroupId(FOLDER, 'all/prod'))
  })

  it('keeps local settings across a sync, and applies them over the repository', async () => {
    gitFolderStore.saveOverride({ nodeId: gitHostId(FOLDER, 'web1'), username: 'root' })
    await gitFolderStore.preview(FOLDER)
    gitFolderStore.apply(FOLDER, ['all', 'all/prod'], forget)

    expect(gitFolderStore.findSession(gitHostId(FOLDER, 'web1'))?.username).toBe('root')
  })

  it('says what a commit has taken away before anything is applied', async () => {
    writeInventory(PROD_ONLY)
    const preview = await gitFolderStore.preview(FOLDER)

    expect(preview.groups.map((g) => g.path)).toEqual(['all', 'all/prod'])
    expect(preview.removedGroups).toEqual([])
    expect(preview.removedHosts.map((h) => h.name)).toEqual(['db1'])
    // The folder still shows both hosts: this was a question, not a change.
    expect(gitFolderStore.treeOf(FOLDER)?.sessions).toHaveLength(2)
  })

  it('drops a host that has left the inventory, and its local settings with it', async () => {
    gitFolderStore.saveOverride({ nodeId: gitHostId(FOLDER, 'db1'), username: 'dba' })
    await gitFolderStore.preview(FOLDER)
    gitFolderStore.apply(FOLDER, ['all', 'all/prod'], forget)

    expect(gitFolderStore.treeOf(FOLDER)?.sessions.map((s) => s.name)).toEqual(['web1'])
    expect(gitFolderStore.overrides().map((o) => o.nodeId)).toEqual([gitHostId(FOLDER, 'web1')])
    // The vault entry goes with it rather than being left unreachable.
    expect(forgotten).toContain(gitHostId(FOLDER, 'db1'))
  })

  it('offers a group that has come back as new again', async () => {
    writeInventory(BOTH)
    const preview = await gitFolderStore.preview(FOLDER)

    // dev was gone from the repository at the last sync, so its return is a
    // discovery like any other — and it arrives ticked, under a chosen parent.
    expect(preview.groups.find((g) => g.path === 'all/dev')?.isNew).toBe(true)
    expect(preview.included).toEqual(['all', 'all/prod', 'all/dev'])
  })

  it('does not offer a group unticked on purpose as new on the next sync', async () => {
    // Take prod alone while the repository holds dev too: dev is then known and
    // deliberately left out, which is a different thing from never having seen it.
    await gitFolderStore.preview(FOLDER)
    gitFolderStore.apply(FOLDER, ['all', 'all/prod'], forget)
    expect(linkNow().knownGroups).toContain('all/dev')

    const preview = await gitFolderStore.preview(FOLDER)
    expect(preview.groups.find((g) => g.path === 'all/dev')?.isNew).toBe(false)
    expect(preview.included).toEqual(['all', 'all/prod'])
  })

  it('remembers the repository, so the next folder can be pointed at it', () => {
    expect(gitFolderStore.repos().map((r) => r.url)).toEqual([repo])
  })

  it('reads one repository from two folders through a single checkout', async () => {
    sessionStore.saveGroup({
      id: 'folder-2',
      name: 'Dev',
      parentId: null,
      git: { repoUrl: repo, paths: ['hosts.yml'], includedGroups: [] }
    })

    const preview = await gitFolderStore.preview('folder-2')
    // The other folder takes a different part of the same inventory.
    gitFolderStore.apply('folder-2', ['all/dev'], forget)

    expect(preview.groups.map((g) => g.path)).toEqual(['all', 'all/prod', 'all/dev'])
    expect(gitFolderStore.treeOf('folder-2')?.sessions.map((s) => s.name)).toEqual(['dev1'])
    // The first folder is untouched by the second's sync.
    expect(
      gitFolderStore
        .treeOf(FOLDER)
        ?.sessions.map((s) => s.name)
        .sort()
    ).toEqual(['db1', 'web1'])
    // One clone between them, and one entry in the list rather than two.
    expect(readdirSync(join(userData, 'git-folder-repos'))).toHaveLength(1)
    expect(gitFolderStore.repos()).toHaveLength(1)
  })

  it('keeps the checkout while another folder is still reading it', () => {
    // Deleting a folder forgets it and then removes the group, in that order —
    // which is what tells the next `forget` whether anyone is left.
    gitFolderStore.forget('folder-2', forget)
    expect(readdirSync(join(userData, 'git-folder-repos'))).toHaveLength(1)
    sessionStore.deleteGroup('folder-2')
  })

  it('empties the folder and forgets its settings when it is untied', () => {
    gitFolderStore.forget(FOLDER, forget)

    expect(gitFolderStore.treeOf(FOLDER)).toBeUndefined()
    expect(gitFolderStore.overrides()).toEqual([])
    expect(forgotten).toContain(gitHostId(FOLDER, 'web1'))
    // The last folder reading it has gone, so the working copy goes too. The
    // saved repository stays: it is there to be picked again.
    expect(readdirSync(join(userData, 'git-folder-repos'))).toEqual([])
    expect(gitFolderStore.repos().map((r) => r.url)).toEqual([repo])
  })
})
