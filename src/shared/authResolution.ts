import type { AuthDefaults, ResolvedAuth, SessionGroup } from './types'

export const AUTH_FALLBACK: ResolvedAuth = {
  port: 22,
  username: '',
  authMethod: 'password',
  agentForward: false,
  jumpHostId: null
}

/**
 * The chain a value is looked up along: the item itself, then its group, then
 * that group's parent, and so on. Nearest definition wins.
 */
export function inheritanceChain(
  own: AuthDefaults,
  groupId: string | null,
  groups: SessionGroup[]
): AuthDefaults[] {
  const chain: AuthDefaults[] = [own]
  // Opted out: the item stands on its own settings alone.
  if (own.inheritAuth === false) return chain

  const seen = new Set<string>()
  let cursor = groupId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    const group = groups.find((g) => g.id === cursor)
    if (!group) break
    chain.push(group)
    // A group that opted out still contributes its own values, but the walk
    // stops there rather than reaching its parent.
    if (group.inheritAuth === false) break
    cursor = group.parentId
  }
  return chain
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
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
  const chain = inheritanceChain(own, groupId, groups)
  return {
    port: pick(chain, 'port') ?? AUTH_FALLBACK.port,
    username: pick(chain, 'username') ?? AUTH_FALLBACK.username,
    authMethod: pick(chain, 'authMethod') ?? AUTH_FALLBACK.authMethod,
    privateKeyPath: pick(chain, 'privateKeyPath'),
    secretRef: pick(chain, 'secretRef'),
    // Booleans can be legitimately false, so they take the first explicit value.
    agentForward: firstDefined(chain, 'agentForward') ?? AUTH_FALLBACK.agentForward,
    jumpHostId: pick(chain, 'jumpHostId') ?? AUTH_FALLBACK.jumpHostId
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
  for (const level of inheritanceChain(own, groupId, groups).slice(1)) {
    if (isSet(level[key])) return level as SessionGroup
  }
  return undefined
}
