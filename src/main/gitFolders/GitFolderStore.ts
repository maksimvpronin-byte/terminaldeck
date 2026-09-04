import { app } from 'electron'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { parse } from 'yaml'
import type {
  GitFolderData,
  GitFolderLink,
  GitFolderPreview,
  GitFolderPreviewGroup,
  GitFolderTree,
  GitRepo,
  InventoryOverride,
  SessionGroup,
  SessionProfile
} from '../../shared/types'
import { gitNodePrefix, groupPathOf, pruneTree, reconcileSelection } from '../../shared/gitFolders'
import { applyOverride } from '../../shared/overrides'
import { parseAnsibleInventory } from '../inventory/ansible'
import { noInventoryFound, readVarsFor, resolveInventoryFiles } from '../inventory/files'
import { headRevision, syncRepo } from '../inventory/GitRepo'
import { removeTree } from './removeTree'
import { readJson, writeJson } from '../store/jsonFile'
import { sessionStore } from '../store/SessionStore'

/**
 * Sessions folders that mirror an Ansible inventory out of git.
 *
 * The difference from an Inventory source is not the parsing — that is the same
 * code — but when the network is touched and where the result lives. A folder's
 * hosts are written to disk and shown the moment the window opens; going to git
 * happens when it is asked for, and what it brings back is agreed to in a dialog
 * before anything on disk changes.
 */

function dataPath(): string {
  return join(app.getPath('userData'), 'git-folders.json')
}

function reposRoot(): string {
  return join(app.getPath('userData'), 'git-folder-repos')
}

/**
 * Where a repository is checked out, which is decided by the repository and not
 * by the folder reading it.
 *
 * Two folders on the same inventory — production out of one file, staging out
 * of another — are the ordinary case, and keying the checkout by folder cloned
 * the same repository once per folder: the disk twice over, the fetch twice
 * over, and two working copies to disagree with each other. Keyed by what
 * actually decides the contents, they share one.
 *
 * Hashed rather than made readable: an address is not a filename, and the
 * characters in one that are meaningful to a path are exactly the interesting
 * ones.
 */
function checkoutFor(url: string, branch?: string): string {
  const key = createHash('sha1').update(`${url}\n${branch ?? ''}`).digest('hex').slice(0, 16)
  return join(reposRoot(), key)
}

/** The whole repository as parsed, before the chosen groups are cut out of it. */
interface ParsedRepo {
  tree: GitFolderTree
  paths: string[]
  revision?: string
  files: string[]
  warning?: string
}

class GitFolderStore {
  private data: GitFolderData
  /**
   * What the last preview read, kept until it is applied.
   *
   * A sync is two steps with a person in the middle, and re-reading the working
   * copy after they have answered would parse a tree that nobody was shown.
   */
  private pending = new Map<string, ParsedRepo>()
  /**
   * One git command at a time per working copy.
   *
   * A sync fetches, resets and cleans; two folders sharing a repository can ask
   * for that at the same moment, and the second would be reading files the
   * first is in the middle of replacing.
   */
  private busy = new Map<string, Promise<unknown>>()

  private queue<T>(dir: string, work: () => Promise<T>): Promise<T> {
    const next = (this.busy.get(dir) ?? Promise.resolve()).then(work, work)
    // Kept whether it succeeded or not, so a failure does not wedge the queue.
    this.busy.set(
      dir,
      next.catch(() => undefined)
    )
    return next
  }

  constructor() {
    this.data = this.load()
  }

  private load(): GitFolderData {
    const parsed = readJson<Partial<GitFolderData>>(dataPath(), () => ({}))
    return {
      version: 1,
      trees: parsed.trees ?? [],
      overrides: parsed.overrides ?? [],
      repos: parsed.repos ?? []
    }
  }

  private persist(): void {
    writeJson(dataPath(), this.data)
  }

  trees(): GitFolderTree[] {
    return this.data.trees
  }

  overrides(): InventoryOverride[] {
    return this.data.overrides
  }

  /** Repositories that have been used, most recently used first. */
  repos(): GitRepo[] {
    return [...(this.data.repos ?? [])].sort((a, b) => b.usedAt - a.usedAt)
  }

  /**
   * Notes a repository as one to offer next time. Called on a successful sync
   * rather than on save, so what is offered is what has actually been read.
   */
  private rememberRepo(url: string, branch?: string): void {
    const repos = this.data.repos ?? []
    const found = repos.find((r) => r.url === url && (r.branch ?? '') === (branch ?? ''))
    if (found) found.usedAt = Date.now()
    else repos.push({ url, branch, usedAt: Date.now() })
    this.data.repos = repos
  }

  /** Drops a saved repository. Any folder still reading it is left alone. */
  forgetRepo(url: string, branch?: string): void {
    this.data.repos = (this.data.repos ?? []).filter(
      (r) => !(r.url === url && (r.branch ?? '') === (branch ?? ''))
    )
    this.persist()
  }

  /** The folder as it is saved, and its link, or nothing if it has none. */
  private linkOf(groupId: string): { folder: SessionGroup; link: GitFolderLink } | undefined {
    const folder = sessionStore.getAll().groups.find((g) => g.id === groupId)
    return folder?.git ? { folder, link: folder.git } : undefined
  }

  private saveLink(folder: SessionGroup, patch: Partial<GitFolderLink>): void {
    sessionStore.saveGroup({ ...folder, git: { ...folder.git!, ...patch } })
  }

  /** Reads the repository into our shapes, without deciding anything about it. */
  private async read(folderId: string, link: GitFolderLink): Promise<ParsedRepo> {
    const checkout = checkoutFor(link.repoUrl, link.branch)
    // One at a time per working copy: a sync resets and cleans it, and two
    // folders sharing a repository can ask at the same moment.
    const dir = await this.queue(checkout, () =>
      syncRepo(reposRoot(), basename(checkout), link.repoUrl, link.branch)
    )
    /*
     * The clone this folder had to itself, before checkouts were shared. Left
     * behind it is a whole repository per folder that nothing will ever read
     * again — and on an inventory of any size that is the largest thing this
     * application keeps.
     */
    removeTree(join(reposRoot(), folderId))

    const files = resolveInventoryFiles(dir, link.paths)

    const tree: GitFolderTree = { groupId: folderId, groups: [], sessions: [], memberships: {} }
    for (const file of files) {
      const baseDir = dirname(file)
      const doc = parse(readFileSync(file, 'utf8'))
      const parsed = parseAnsibleInventory(
        doc,
        folderId,
        (kind, name) => readVarsFor(baseDir, kind === 'group' ? 'group_vars' : 'host_vars', name),
        'git'
      )
      // Several inventory files can describe the same groups; keep the first.
      for (const g of parsed.groups) {
        if (tree.groups.some((x) => x.id === g.id)) continue
        // The folder itself stands where the inventory's own root would be, so
        // what is set on it is inherited by everything the repository produces.
        tree.groups.push({ ...g, parentId: g.parentId ?? folderId })
      }
      for (const h of parsed.hosts) {
        if (!tree.sessions.some((x) => x.id === h.id)) tree.sessions.push(h)
      }
      // Unioned rather than kept from the first file: a host named in two files
      // belongs to the groups of both.
      for (const [hostKey, groupIds] of Object.entries(parsed.memberships)) {
        tree.memberships[hostKey] = [...new Set([...(tree.memberships[hostKey] ?? []), ...groupIds])]
      }
    }

    const paths = tree.groups
      .map((g) => groupPathOf(folderId, g.id))
      .filter((p): p is string => p !== undefined)

    return {
      tree,
      paths,
      revision: await headRevision(dir).catch(() => undefined),
      files: files.map((f) => relative(dir, f)),
      warning: files.length === 0 ? noInventoryFound(link.paths) : undefined
    }
  }

  /**
   * Pulls the repository and works out what taking it would mean. Nothing the
   * folder shows changes until `apply` is called with an answer.
   */
  async preview(folderId: string): Promise<GitFolderPreview> {
    const found = this.linkOf(folderId)
    if (!found) throw new Error('This folder is not linked to a repository')
    const { folder, link } = found

    let repo: ParsedRepo
    try {
      repo = await this.read(folderId, link)
    } catch (err) {
      // Recorded on the folder as well as thrown: the tree keeps showing what it
      // has, and says underneath why it is not newer.
      this.saveLink(folder, { lastError: (err as Error).message })
      throw err
    }
    this.pending.set(folderId, repo)

    const { included, newPaths, removedGroups } = reconcileSelection(repo.paths, {
      included: link.includedGroups,
      known: link.knownGroups
    })

    const byPath = new Map(
      repo.tree.groups.map((g) => [groupPathOf(folderId, g.id) ?? g.id, g] as const)
    )
    const groups: GitFolderPreviewGroup[] = repo.paths.map((path) => {
      const group = byPath.get(path)!
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
      return {
        path,
        name: group.name,
        parentPath: parentPath && repo.paths.includes(parentPath) ? parentPath : null,
        hostCount: Object.values(repo.tree.memberships).filter((ids) => ids.includes(group.id))
          .length,
        isNew: newPaths.includes(path)
      }
    })

    // Hosts about to go: what this folder shows now, minus what the chosen
    // groups would still hold. Local settings are called out — deleting the host
    // deletes them, and its stored password with them.
    const wouldKeep = new Set(pruneTree(folderId, repo.tree, included).sessions.map((s) => s.id))
    const removedHosts = (this.treeOf(folderId)?.sessions ?? [])
      .filter((h) => !wouldKeep.has(h.id))
      .map((h) => ({
        id: h.id,
        name: h.name,
        hasLocalSettings: this.data.overrides.some((o) => o.nodeId === h.id)
      }))

    return {
      groupId: folderId,
      groups,
      included,
      removedGroups,
      removedHosts,
      revision: repo.revision,
      files: repo.files,
      warning: repo.warning
    }
  }

  /**
   * Takes the answer: the chosen groups become what the folder shows, and
   * everything the repository no longer has goes, along with the local settings
   * that addressed it.
   *
   * `forgetSecret` is handed in rather than imported so this file stays clear of
   * the vault; the caller pairs the two, as it does for a host or a group.
   */
  apply(
    folderId: string,
    includedGroups: string[],
    forgetSecret: (override: InventoryOverride) => void
  ): GitFolderTree {
    const found = this.linkOf(folderId)
    if (!found) throw new Error('This folder is not linked to a repository')
    const repo = this.pending.get(folderId)
    if (!repo) throw new Error('Sync this folder again: what it read has been forgotten')

    const included = includedGroups.filter((p) => repo.paths.includes(p))
    const tree = pruneTree(folderId, repo.tree, included)

    this.data.trees = [...this.data.trees.filter((t) => t.groupId !== folderId), tree]
    this.dropOrphanedOverrides(folderId, forgetSecret)
    // Noted on a successful sync rather than on save, so what is offered to the
    // next folder is a repository that has actually been read.
    this.rememberRepo(found.link.repoUrl, found.link.branch)
    this.persist()

    this.saveLink(found.folder, {
      includedGroups: included,
      knownGroups: repo.paths,
      lastSyncedAt: Date.now(),
      lastRevision: repo.revision,
      lastFiles: repo.files,
      lastError: repo.warning
    })
    this.pending.delete(folderId)
    return tree
  }

  /**
   * Local settings for nodes this folder no longer shows, and the passwords they
   * hold. A host that has gone from the inventory has gone: leaving its override
   * behind would keep a credential in the vault that nothing points at.
   */
  private dropOrphanedOverrides(
    folderId: string,
    forgetSecret: (override: InventoryOverride) => void
  ): void {
    const live = new Set([
      ...(this.treeOf(folderId)?.groups ?? []).map((g) => g.id),
      ...(this.treeOf(folderId)?.sessions ?? []).map((s) => s.id)
    ])
    const prefix = gitNodePrefix(folderId)
    const orphaned = this.data.overrides.filter((o) => o.nodeId.startsWith(prefix) && !live.has(o.nodeId))
    for (const override of orphaned) forgetSecret(override)
    this.data.overrides = this.data.overrides.filter((o) => !orphaned.includes(o))
  }

  treeOf(folderId: string): GitFolderTree | undefined {
    return this.data.trees.find((t) => t.groupId === folderId)
  }

  /**
   * Everything a folder holds, so deleting it can take the lot: its cached tree
   * and every local setting addressed to a node of it.
   */
  forget(folderId: string, forgetSecret: (override: InventoryOverride) => void): void {
    this.dropCheckout(folderId)
    const prefix = gitNodePrefix(folderId)
    for (const override of this.data.overrides.filter((o) => o.nodeId.startsWith(prefix))) {
      forgetSecret(override)
    }
    this.data.overrides = this.data.overrides.filter((o) => !o.nodeId.startsWith(prefix))
    this.data.trees = this.data.trees.filter((t) => t.groupId !== folderId)
    this.pending.delete(folderId)
    this.persist()
  }

  /**
   * The working copy, once nothing is reading it any more.
   *
   * Shared, so it goes only when the last folder pointing at that repository
   * does — otherwise untying one folder would take the checkout out from under
   * its neighbour. The saved repository itself stays in the list: it is there
   * to be picked again, and re-cloning is what picking it means.
   */
  private dropCheckout(folderId: string): void {
    const link = this.linkOf(folderId)?.link
    if (!link) return
    const shared = sessionStore
      .getAll()
      .groups.some(
        (g) =>
          g.id !== folderId &&
          g.git?.repoUrl === link.repoUrl &&
          (g.git.branch ?? '') === (link.branch ?? '')
      )
    if (shared) return
    removeTree(checkoutFor(link.repoUrl, link.branch))
  }

  saveOverride(override: InventoryOverride): void {
    const idx = this.data.overrides.findIndex((o) => o.nodeId === override.nodeId)
    if (idx >= 0) this.data.overrides[idx] = override
    else this.data.overrides.push(override)
    this.persist()
  }

  clearOverride(nodeId: string): void {
    this.data.overrides = this.data.overrides.filter((o) => o.nodeId !== nodeId)
    this.persist()
  }

  /** The host as it will be used: what the repository said, then the local override. */
  findSession(sessionId: string): SessionProfile | undefined {
    for (const tree of this.data.trees) {
      const found = tree.sessions.find((s) => s.id === sessionId)
      if (!found) continue
      return applyOverride(
        found,
        this.data.overrides.find((o) => o.nodeId === sessionId)
      )
    }
    return undefined
  }

  /**
   * Every group of every folder, with local overrides applied — auth resolution
   * walks up through these into the folder the user made, and on up from there.
   */
  allGroups(): SessionGroup[] {
    return this.data.trees
      .flatMap((t) => t.groups)
      .map((g) => applyOverride(g, this.data.overrides.find((o) => o.nodeId === g.id)))
  }
}

export const gitFolderStore = new GitFolderStore()
