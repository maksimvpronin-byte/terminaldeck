import { resolveAuth } from './authResolution'
import type { Credential, SessionGroup, SessionProfile, SshConfigHost } from './types'

export type SshImportPlan =
  { ok: true; profiles: SessionProfile[] } | { ok: false; problems: SshImportProblem[] }

/** A host that cannot be imported as its config describes it. */
export interface SshImportProblem {
  alias: string
  /** The jump host that could not be found, or the one that goes the wrong way. */
  hop: string
  reason: 'missing' | 'route' | 'differs'
  /** For `differs`: the login the entry asks for, and the one the jump host has. */
  wanted?: string
  found?: string
}

/** What a `ProxyJump` entry names: `[user@]host[:port]`, or the same as an ssh:// URI. */
interface HopSpec {
  alias: string
  user?: string
  port?: number
}

function hopSpec(spec: string): HopSpec {
  const uri = spec.trim().replace(/^ssh:\/\//i, '')
  const at = uri.lastIndexOf('@')
  const user = at >= 0 ? uri.slice(0, at) : undefined
  const bare = at >= 0 ? uri.slice(at + 1) : uri
  // An IPv6 address comes bracketed when it has a port after it.
  const bracketed = bare.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracketed) {
    return { alias: bracketed[1], user, port: bracketed[2] ? Number(bracketed[2]) : undefined }
  }
  const ported = bare.match(/^(.*):(\d+)$/)
  if (ported) return { alias: ported[1], user, port: Number(ported[2]) }
  return { alias: bare, user }
}

/** `user@host:port`, the way a ProxyJump entry would name it. */
function loginOf(user: string | undefined, host: string, port: number): string {
  return `${user ? `${user}@` : ''}${host}:${port}`
}

/**
 * Turns the chosen `~/.ssh/config` hosts into profiles, every route checked
 * before anything is made.
 *
 * A `ProxyJump` that named a host neither chosen nor already saved used to be
 * dropped without a word, and the host imported as a direct connection — to a
 * machine that only a bastion can reach, or worse, one that should only ever
 * be reached through it. A chain (`j1,j2`) was dropped the same way even when
 * both hops were there. Now the route is resolved whole: each hop has to be
 * found, and in a chain each hop has to be reached through the one before it,
 * which is how TerminalDeck follows jump hosts. Anything else is reported and
 * nothing is imported, so the dialog can say which hosts to add or untick.
 */
export function planSshImport(
  chosen: SshConfigHost[],
  saved: SessionProfile[],
  groups: SessionGroup[],
  makeId: () => string,
  now: number,
  credentials: Credential[] = [],
  /** Who a jump host with no login is reached as: this machine's user, as ssh does. */
  localUser = ''
): SshImportPlan {
  const created = new Map<string, SessionProfile>()
  for (const h of chosen) {
    created.set(h.alias, {
      id: makeId(),
      name: h.alias,
      host: h.hostname,
      // Only what the config actually stated; the rest is left to inherit.
      port: h.port === 22 ? undefined : h.port,
      username: h.user,
      authMethod: h.identityFile ? 'privateKey' : 'agent',
      privateKeyPath: h.identityFile,
      groupId: null,
      tags: ['ssh-config'],
      logToFile: false,
      portForwards: [],
      createdAt: now,
      updatedAt: now
    })
  }
  // By every name its Host line gives it: ssh takes `bastion` in
  // `Host jump bastion` for the same host, and a ProxyJump naming it was missing.
  const named = new Map(created)
  for (const h of chosen) {
    for (const other of h.otherAliases ?? []) {
      if (!named.has(other)) named.set(other, created.get(h.alias)!)
    }
  }
  const find = (alias: string): SessionProfile | undefined =>
    named.get(alias) ?? saved.find((s) => s.name === alias)

  const problems: SshImportProblem[] = []
  const chains = new Map<string, SessionProfile[]>()
  for (const h of chosen) {
    if (!h.proxyJump || h.proxyJump.trim().toLowerCase() === 'none') continue
    const hops: SessionProfile[] = []
    for (const spec of h.proxyJump.split(',')) {
      const wanted = hopSpec(spec)
      const hop = find(wanted.alias)
      if (!hop) {
        problems.push({ alias: h.alias, hop: wanted.alias, reason: 'missing' })
        break
      }
      /*
       * A login or port the entry names has to be the jump host's own. The
       * saved one was linked whatever it had, and `admin@bastion:2222` went
       * through `root@bastion:22` without a word; ssh uses what the entry
       * says. Told instead, so the jump host or the config can be put right.
       */
      const resolved = resolveAuth(hop, hop.groupId, groups, { credentials })
      const has = { ...resolved, username: resolved.username || localUser }
      if (
        (wanted.user !== undefined && wanted.user !== has.username) ||
        (wanted.port !== undefined && wanted.port !== has.port)
      ) {
        problems.push({
          alias: h.alias,
          hop: hop.name,
          reason: 'differs',
          wanted: loginOf(wanted.user ?? has.username, wanted.alias, wanted.port ?? has.port),
          found: loginOf(has.username, wanted.alias, has.port)
        })
        break
      }
      hops.push(hop)
    }
    if (hops.length === h.proxyJump.split(',').length) {
      chains.set(h.alias, hops)
      created.get(h.alias)!.jumpHostId = hops[hops.length - 1].id
    }
  }

  // Checked once every imported host has its jump set: a hop may be one of them.
  const jumpOf = (p: SessionProfile): string | null =>
    created.get(p.name) === p
      ? (p.jumpHostId ?? null)
      : resolveAuth(p, p.groupId, groups).jumpHostId
  for (const [alias, hops] of chains) {
    for (let k = 1; k < hops.length; k++) {
      if (jumpOf(hops[k]) !== hops[k - 1].id) {
        problems.push({ alias, hop: hops[k].name, reason: 'route' })
        break
      }
    }
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, profiles: [...created.values()] }
}
