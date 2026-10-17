/**
 * A password or token written into a repository address.
 *
 * Git takes `https://user:TOKEN@host/repo.git`, and so did this application —
 * and kept the address as it was given: in `inventories.json` and on the
 * folder in the sessions file, both in the clear, and in a backup exported
 * "without credentials". Git has a place for the secret, its credential
 * helper, and that is where the application has always meant it to be; so an
 * address carrying one is refused when it is entered, and cleaned out of what
 * an export writes.
 *
 * Only an address with a scheme can carry one: the scp-like `git@host:path`
 * has a user and nothing else. A user name on its own is a secret only when it
 * is shaped like a token, which is how GitHub takes one (`https://ghp_…@`).
 */

/** GitHub's and GitLab's token prefixes, and a classic 40-hex GitHub token. */
const TOKEN_USER = /^(?:gh[pousr]_|github_pat_|glpat-|gldt-|glptt-)|^[0-9a-f]{40}$/i

interface Userinfo {
  /** Everything before the user, e.g. `https://`. */
  before: string
  user: string
  password?: string
  /** Everything after the `@`. */
  after: string
}

function userinfoOf(url: string): Userinfo | undefined {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url)
  if (!scheme) return undefined
  const start = scheme[0].length
  const rest = url.slice(start)
  const end = rest.search(/[/?#]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  const at = authority.lastIndexOf('@')
  if (at === -1) return undefined
  const info = authority.slice(0, at)
  const colon = info.indexOf(':')
  return {
    before: url.slice(0, start),
    user: colon === -1 ? info : info.slice(0, colon),
    password: colon === -1 ? undefined : info.slice(colon + 1),
    after: url.slice(start + at + 1)
  }
}

function tokenShaped(user: string): boolean {
  let plain = user
  try {
    plain = decodeURIComponent(user)
  } catch {
    // Not percent-encoded after all; read it as written.
  }
  return TOKEN_USER.test(plain)
}

/** Whether the address carries a password, or a token in place of a user. */
export function repoUrlHasSecret(url: string): boolean {
  const info = userinfoOf(url.trim())
  if (!info) return false
  return !!info.password || tokenShaped(info.user)
}

/** The address with any password or token taken out, and an ordinary user kept. */
export function withoutRepoSecret(url: string): string {
  const info = userinfoOf(url)
  if (!info || (!info.password && !tokenShaped(info.user))) return url
  const user = tokenShaped(info.user) ? '' : info.user
  return `${info.before}${user ? `${user}@` : ''}${info.after}`
}

/** A folder, with any secret taken out of the repository it mirrors. */
export function groupWithoutRepoSecret<G extends { git?: { repoUrl: string } }>(group: G): G {
  if (!group.git || !repoUrlHasSecret(group.git.repoUrl)) return group
  return { ...group, git: { ...group.git, repoUrl: withoutRepoSecret(group.git.repoUrl) } }
}

/** An inventory source, with any secret taken out of its address. */
export function sourceWithoutRepoSecret<S extends { repoUrl: string }>(source: S): S {
  if (!repoUrlHasSecret(source.repoUrl)) return source
  return { ...source, repoUrl: withoutRepoSecret(source.repoUrl) }
}
