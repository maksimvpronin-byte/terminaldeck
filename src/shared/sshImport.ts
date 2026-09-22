import { resolveAuth } from './authResolution'
import type { SessionGroup, SessionProfile, SshConfigHost } from './types'

export type SshImportPlan =
  { ok: true; profiles: SessionProfile[] } | { ok: false; problems: SshImportProblem[] }

/** A host that cannot be imported as its config describes it. */
export interface SshImportProblem {
  alias: string
  /** The jump host that could not be found, or the one that goes the wrong way. */
  hop: string
  reason: 'missing' | 'route'
}

/** The host a `ProxyJump` entry names: `[user@]host[:port]`, or the same as an ssh:// URI. */
function hopAlias(spec: string): string {
  const bare = spec
    .trim()
    .replace(/^ssh:\/\//i, '')
    .replace(/^.*@/, '')
  // An IPv6 address comes bracketed when it has a port after it.
  const bracketed = bare.match(/^\[([^\]]+)\]/)
  if (bracketed) return bracketed[1]
  return bare.replace(/:\d+$/, '')
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
  now: number
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
  const find = (alias: string): SessionProfile | undefined =>
    created.get(alias) ?? saved.find((s) => s.name === alias)

  const problems: SshImportProblem[] = []
  const chains = new Map<string, SessionProfile[]>()
  for (const h of chosen) {
    if (!h.proxyJump || h.proxyJump.trim().toLowerCase() === 'none') continue
    const hops: SessionProfile[] = []
    for (const spec of h.proxyJump.split(',')) {
      const alias = hopAlias(spec)
      const hop = find(alias)
      if (!hop) {
        problems.push({ alias: h.alias, hop: alias, reason: 'missing' })
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
