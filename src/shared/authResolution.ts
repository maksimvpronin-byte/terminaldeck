import { inheritanceChain } from './inheritance'
import { isSet } from './overrides'
import type { AuthDefaults, ResolvedAuth, SessionGroup } from './types'

export const AUTH_FALLBACK: ResolvedAuth = {
  port: 22,
  username: '',
  authMethod: 'password',
  agentForward: false,
  jumpHostId: null,
  followTerminalCwd: false
}

const optedOut = (level: AuthDefaults): boolean => level.inheritAuth === false

/**
 * The chain a value is looked up along: the item itself, then its group, then
 * that group's parent, and so on. Nearest definition wins.
 */
export function authChain(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[]
): AuthDefaults[] {
  return inheritanceChain(own, groupId, groups, optedOut)
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
  groups: SessionGroup[]
): ResolvedAuth {
  const chain = authChain(own, groupId, groups)
  return {
    port: pick(chain, 'port') ?? AUTH_FALLBACK.port,
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
 * Where each effective value came from, so the UI can show what a blank field
 * will actually use. Returns undefined when the value is the item's own.
 */
export function inheritedFrom(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[],
  key: keyof AuthDefaults
): SessionGroup | undefined {
  if (isSet(own[key])) return undefined
  // Skip the item itself; everything after it in the chain is an ancestor group.
  for (const level of authChain(own, groupId, groups).slice(1)) {
    if (isSet(level[key])) return level as SessionGroup
  }
  return undefined
}
