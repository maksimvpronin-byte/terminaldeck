import type { GitFolderLink } from '../../../shared/types'

/**
 * Where a git folder's inventory can be looked at in a browser.
 *
 * The address git clones from is turned into the forge's web page: an SSH
 * form loses its user and port (the SSH port says nothing about the web one),
 * an HTTPS form loses any login or token written into it, so a password never
 * reaches the browser's history. With a single path the page is that file or
 * directory on the folder's branch; with several it is the repository itself.
 *
 * GitHub and Bitbucket have layouts of their own; anything else is taken for
 * GitLab, which is what a self-hosted server usually is. Both GitHub and
 * GitLab send a `tree` link that points at a file on to the file's page, so
 * the path does not need to be told apart as one or the other.
 *
 * Undefined for what has no web page: a local path, a `file://` clone.
 */
export function repoWebUrl(
  link: Pick<GitFolderLink, 'repoUrl' | 'branch' | 'paths'>
): string | undefined {
  const base = webBase(link.repoUrl.trim())
  if (!base) return undefined
  const paths = link.paths.map(cleanPath).filter(Boolean)
  const path = paths.length === 1 ? paths[0] : ''
  const branch = link.branch?.trim()
  if (!path && !branch) return base.url
  // No branch means the repository's default one, which HEAD names on every forge.
  const ref = segments(branch || 'HEAD')
  const rest = path ? `/${segments(path)}` : ''
  if (base.host === 'github.com') return `${base.url}/tree/${ref}${rest}`
  if (base.host === 'bitbucket.org') return `${base.url}/src/${ref}${rest}`
  return `${base.url}/-/tree/${ref}${rest}`
}

function webBase(repoUrl: string): { url: string; host: string } | undefined {
  let host: string
  let port = ''
  let project: string
  // scp-like `git@host:group/repo.git` — no scheme, a colon before the first
  // slash. A single letter there is a Windows drive, as git itself reads it.
  const scp = /^(?:[^@/\\\s]+@)?([^:/\\\s]{2,}):(?!\/\/)([^\\]+)$/.exec(repoUrl)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(repoUrl)) {
    host = scp[1]
    project = scp[2]
  } else {
    let parsed: URL
    try {
      parsed = new URL(repoUrl)
    } catch {
      return undefined
    }
    const scheme = parsed.protocol
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(scheme)) {
      return undefined
    }
    host = parsed.hostname
    if (scheme === 'http:' || scheme === 'https:') port = parsed.port ? `:${parsed.port}` : ''
    project = decodeURIComponent(parsed.pathname)
    // Over HTTP the forge answers on the scheme it was cloned with.
    if (scheme === 'http:') {
      return finish(`http://${host}${port}`, host, project)
    }
  }
  return finish(`https://${host}${port}`, host, project)
}

function finish(
  origin: string,
  host: string,
  project: string
): { url: string; host: string } | undefined {
  const name = project
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!host || !name) return undefined
  return { url: `${origin}/${segments(name)}`, host: host.toLowerCase() }
}

function cleanPath(path: string): string {
  return path
    .trim()
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function segments(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}
