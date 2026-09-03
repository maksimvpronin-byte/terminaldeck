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

/**
 * Refuses a value git would read as an option rather than as what it is.
 *
 * `execFile` takes an argument list, so there is no shell and nothing to
 * escape — but git still parses its own arguments, and a repository URL
 * beginning with a dash is not a URL to it. `--upload-pack=<command>` in that
 * position runs the command. Nobody would type that; the URL does not have to
 * be typed, because it also arrives through an imported backup or a
 * configuration somebody else prepared.
 */
function refuseOption(what: string, value: string): void {
  if (value.startsWith('-')) {
    throw new Error(`The ${what} may not begin with a dash: git would read it as an option`)
  }
}

/** Clones on first use, then fast-forwards. Returns the checkout directory. */
export async function syncRepo(
  root: string,
  sourceId: string,
  repoUrl: string,
  branch?: string
): Promise<string> {
  refuseOption('repository address', repoUrl)
  if (branch) refuseOption('branch', branch)

  const dir = join(root, sourceId)

  if (!existsSync(join(dir, '.git'))) {
    // Shallow and single-branch: we only ever read the current tree.
    const args = ['clone', '--depth', '1', '--single-branch']
    if (branch) args.push('--branch', branch)
    // Everything after this is a path or a URL, whatever it looks like.
    args.push('--', repoUrl, dir)
    await git(args)
    return dir
  }

  /*
   * The checkout is keyed by the source, not by the address, so an address that
   * has been edited since the clone would otherwise go on fetching the old
   * remote for ever: `fetch origin` asks the working copy where origin is, and
   * nothing had ever told it the answer had changed. A sync of the wrong
   * repository reports success and leaves the hosts as they were, which is the
   * hardest kind of failure to notice.
   */
  const origin = (await git(['remote', 'get-url', 'origin'], dir).catch(() => '')).trim()
  if (origin !== repoUrl) await git(['remote', 'set-url', 'origin', repoUrl], dir)

  // Discard local drift rather than fail on conflicts — this is a read-only mirror.
  await git(['fetch', '--depth', '1', '--', 'origin', branch ?? 'HEAD'], dir)
  await git(['reset', '--hard', 'FETCH_HEAD'], dir)
  await git(['clean', '-fd'], dir)
  return dir
}

export async function headRevision(dir: string): Promise<string> {
  return (await git(['rev-parse', '--short', 'HEAD'], dir)).trim()
}
