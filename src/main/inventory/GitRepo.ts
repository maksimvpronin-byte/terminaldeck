import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'

const run = promisify(execFile)

export class GitMissingError extends Error {
  constructor() {
    super('git was not found on this machine. Install it, or make sure it is on PATH.')
    this.name = 'GitMissingError'
  }
}

/**
 * Repositories are mirrored through the system git binary rather than a bundled
 * client, so existing credentials just work: SSH keys and agents, credential
 * helpers, corporate proxies and self-hosted forges all behave as they do in a
 * terminal. Nothing is ever pushed.
 */
async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', args, {
      cwd,
      // Never let git stop for interactive input; fail with a clear error instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 16 * 1024 * 1024
    })
    return stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') throw new GitMissingError()
    throw new Error((e.stderr || e.message || 'git failed').trim())
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await git(['--version'])
    return true
  } catch {
    return false
  }
}

/** Clones on first use, then fast-forwards. Returns the checkout directory. */
export async function syncRepo(
  root: string,
  sourceId: string,
  repoUrl: string,
  branch?: string
): Promise<string> {
  const dir = join(root, sourceId)

  if (!existsSync(join(dir, '.git'))) {
    // Shallow and single-branch: we only ever read the current tree.
    const args = ['clone', '--depth', '1', '--single-branch']
    if (branch) args.push('--branch', branch)
    args.push(repoUrl, dir)
    await git(args)
    return dir
  }

  // Discard local drift rather than fail on conflicts — this is a read-only mirror.
  await git(['fetch', '--depth', '1', 'origin', branch ?? 'HEAD'], dir)
  await git(['reset', '--hard', 'FETCH_HEAD'], dir)
  await git(['clean', '-fd'], dir)
  return dir
}

export async function headRevision(dir: string): Promise<string> {
  return (await git(['rev-parse', '--short', 'HEAD'], dir)).trim()
}
