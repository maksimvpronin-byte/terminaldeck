import { applyCredential } from './credentials'
import { inheritanceChain } from './inheritance'
import { isSet } from './overrides'
import type { Protocol } from './protocols'
import type {
  AuthDefaults,
  Credential,
  RdpLoginDefaults,
  ResolvedAuth,
  SessionGroup
} from './types'

export const AUTH_FALLBACK: ResolvedAuth = {
  port: 22,
  username: '',
  authMethod: 'password',
  agentForward: false,
  jumpHostId: null,
  followTerminalCwd: false
}

const optedOut = (level: AuthDefaults): boolean => level.inheritAuth === false

/** Port a protocol listens on when nothing along the chain names one. */
const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, rdp: 3389 }

/**
 * What resolution needs to know beyond the chain itself.
 *
 * Both are optional so that a caller asking only for, say, the jump host need
 * not gather them — but a caller that shows or uses a login must pass the
 * accounts, or a folder's default account is invisible to it.
 */
export interface AuthContext {
  /** The protocol of the host being resolved; SSH when absent. */
  protocol?: Protocol
  /** Saved accounts, so a `credentialId` along the chain can be read. */
  credentials?: Credential[]
}

/**
 * A group as an RDP host sees it: the RDP half of the group's settings in
 * place of the SSH half. See `RdpLoginDefaults`.
 */
function asRdpLevel(group: AuthDefaults & RdpLoginDefaults): AuthDefaults {
  const ownLogin =
    isSet(group.rdpUsername) || isSet(group.rdpSecretRef) || isSet(group.rdpCredentialId)
  return {
    ...group,
    port: group.rdpPort,
    ...(ownLogin
      ? {
          username: group.rdpUsername,
          secretRef: group.rdpSecretRef,
          credentialId: group.rdpCredentialId,
          authMethod: 'password' as const,
          privateKeyPath: undefined
        }
      : {})
  }
}

/**
 * The chain a value is looked up along: the item itself, then its group, then
 * that group's parent, and so on. Nearest definition wins.
 *
 * A host an inventory puts in groups beyond that one chain reads them all,
 * latest in Ansible's order first; see `levelsOf`. And a top group that no
 * `all` holds has all's word just beneath it; see `withAll`.
 *
 * For an RDP host every group is seen through `asRdpLevel`; the host itself is
 * not, since a host has one protocol and its own fields already mean it.
 */
export function authChain(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  context: AuthContext = {}
): AuthDefaults[] {
  const chain = withAll(levelsOf(own, groupId, groups))
  // Settings carried for groups a git folder left out sit just above the host.
  const carried = (own as { carriedAuth?: AuthDefaults & RdpLoginDefaults }).carriedAuth
  if (carried && !optedOut(own)) chain.splice(1, 0, carried)
  if (context.protocol !== 'rdp') return chain
  return chain.map((level, i) => (i === 0 ? level : groupLevelFor(level, 'rdp')))
}

/**
 * The item and the groups above it, nearest first.
 *
 * Ansible reads every group a host is in and all of their parents, in one
 * order — shallower first, by name within a level — and the last to state a
 * setting wins. One chain up from the host's group missed the rest: with web
 * under both prod and stage, the chain through stage never saw prod's
 * deploy:2222. So for a host with `groupOrder` every group it reaches is read
 * in that order, each as it stands with its local settings, and what lies
 * above the inventory's groups — a source's own settings, a folder of the
 * user's — comes after them, as it did. A group that opts out of inheriting
 * still ends the walk up through it.
 */
function levelsOf(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[]
): AuthDefaults[] {
  const chain = inheritanceChain(own, groupId, groups, optedOut)
  const { groupOrder, memberOf } = own as { groupOrder?: string[]; memberOf?: string[] }
  if (!groupOrder || optedOut(own)) return chain
  const byId = new Map(groups.map((g) => [g.id, g]))
  const listed = new Set(groupOrder)
  const reached = new Set<string>()
  // What lies above the inventory's groups, from whichever walk reaches it:
  // taken from the host's own chain alone, a group there opting out lost the
  // source's login and jump host that another group still led up to.
  const above: SessionGroup[] = []
  for (const start of [groupId, ...(memberOf ?? [])]) {
    let id = start
    let group = id ? byId.get(id) : undefined
    while (id && group && !reached.has(id)) {
      reached.add(id)
      if (!listed.has(id)) above.push(group)
      if (optedOut(group)) break
      // A top group below another file's all goes there first; all leads on
      // to the same parent.
      id = group.allId && byId.has(group.allId) ? group.allId : group.parentId
      group = id ? byId.get(id) : undefined
    }
  }
  const inventory = [...groupOrder]
    .reverse()
    .filter((id) => reached.has(id))
    .map((id) => byId.get(id)!)
  return [chain[0], ...inventory, ...above]
}

/**
 * The levels with all's word put in, as the shallowest of an inventory's.
 *
 * A top group of an inventory with no `all` holds what all says beneath its
 * own; merged into the group, all's root counted as z's and beat a's deploy
 * for a host in both. It goes once, after the last group that holds it — the
 * shallowest of the inventory's — unless every group holding it opts out.
 */
function withAll(levels: AuthDefaults[]): AuthDefaults[] {
  const holds = (level: AuthDefaults): boolean => (level as SessionGroup).fromAll !== undefined
  const last = levels.findLastIndex(holds)
  if (last < 0) return levels
  // Read while any group holding it still inherits, not only the last one.
  if (levels.every((level) => !holds(level) || optedOut(level))) return levels
  const top = levels[last] as SessionGroup
  const all = { ...top.fromAll, id: `${top.id}#all`, name: 'all', parentId: null }
  return [...levels.slice(0, last + 1), all, ...levels.slice(last + 1)]
}

/**
 * What a group gives a host of this protocol: its RDP side to a desktop, so a
 * group's `ansible_port` — WinRM's 5985 as often as not — never becomes the
 * port a desktop is dialled on. Anything that carries a group's settings onto
 * a host goes through here, so it hands over what resolution would.
 */
export function groupLevelFor(
  group: AuthDefaults & RdpLoginDefaults,
  protocol: Protocol | undefined
): AuthDefaults {
  return protocol === 'rdp' ? asRdpLevel(group) : group
}

/**
 * The account a chain signs in with by default, if it does.
 *
 * Identity is decided by the nearest level that states one, as a login or as
 * an account: a host with a login of its own is not overridden by its
 * folder's account, and a host inside a folder with a login is by its own
 * account. An account that has since been deleted names nothing, and the walk
 * goes on past it.
 */
export function defaultCredential(
  chain: AuthDefaults[],
  credentials: Credential[] | undefined
): Credential | undefined {
  for (const level of chain) {
    if (isSet(level.credentialId)) {
      const found = credentials?.find((c) => c.id === level.credentialId)
      if (found) return found
    }
    if (isSet(level.username)) return undefined
  }
  return undefined
}

function pick<K extends keyof AuthDefaults>(
  chain: AuthDefaults[],
  key: K
): AuthDefaults[K] | undefined {
  // Empty strings count as "not set", so a blank field in the UI inherits.
  for (const level of chain) {
    if (isSet(level[key])) return level[key]
  }
  return undefined
}

export function resolveAuth(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  context: AuthContext = {}
): ResolvedAuth {
  const chain = authChain(own, groupId, groups, context)
  const resolved: ResolvedAuth = {
    ...(pick(chain, 'fileAccess') ? { fileAccess: pick(chain, 'fileAccess') } : {}),
    port: pick(chain, 'port') ?? DEFAULT_PORT[context.protocol ?? 'ssh'],
    username: pick(chain, 'username') ?? AUTH_FALLBACK.username,
    authMethod: pick(chain, 'authMethod') ?? AUTH_FALLBACK.authMethod,
    privateKeyPath: pick(chain, 'privateKeyPath'),
    secretRef: pick(chain, 'secretRef'),
    // Booleans can be legitimately false, so they take the first explicit value.
    agentForward: firstDefined(chain, 'agentForward') ?? AUTH_FALLBACK.agentForward,
    jumpHostId: pick(chain, 'jumpHostId') ?? AUTH_FALLBACK.jumpHostId,
    onConnectCommand: pick(chain, 'onConnectCommand'),
    followTerminalCwd: firstDefined(chain, 'followTerminalCwd') ?? AUTH_FALLBACK.followTerminalCwd
  }
  // An account stands for the login, method, key and password together, so it
  // is laid over the finished result rather than walked field by field — see
  // `applyCredential` for what walking them separately got wrong.
  return applyCredential(resolved, defaultCredential(chain, context.credentials))
}

function firstDefined<K extends keyof AuthDefaults>(
  chain: AuthDefaults[],
  key: K
): AuthDefaults[K] | undefined {
  for (const level of chain) {
    if (level[key] !== undefined) return level[key]
  }
  return undefined
}

/**
 * Which level a value actually comes from: the item itself, a group, or nowhere.
 * `inheritedFrom` cannot tell "the item's own" from "nobody states it", which is
 * exactly the difference when two values are compared to see whether they were
 * set together — a key file and its passphrase, say.
 */
export function sourceOf(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof AuthDefaults,
  context: AuthContext = {}
): 'self' | SessionGroup | undefined {
  if (isSet(own[key])) return 'self'
  return inheritedFrom(own, groupId, groups, key, context)
}

/**
 * Where each effective value came from, so the UI can show what a blank field
 * will actually use. Returns undefined when the value is the item's own.
 */
export function inheritedFrom(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof AuthDefaults,
  context: AuthContext = {}
): SessionGroup | undefined {
  if (isSet(own[key])) return undefined
  // Skip the item itself; everything after it in the chain is an ancestor group.
  for (const level of authChain(own, groupId, groups, context).slice(1)) {
    if (isSet(level[key])) return level as SessionGroup
  }
  return undefined
}
