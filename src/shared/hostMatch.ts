/**
 * Which saved or inventory hosts a name typed on a command line means.
 *
 * `TerminalDeck.exe -s callforce-stat2.nsd.ru` has to find the host whether it
 * was saved under that FQDN, under its short name, or by its IP with the FQDN
 * only as its title — and `-s 10.1.2.3` the other way round. Three tiers, and
 * the first that finds anything is the answer:
 *
 * 1. the name or the address is the very string asked for;
 * 2. one is the other's short name: `callforce-stat2` and
 *    `callforce-stat2.nsd.ru` are taken for one machine;
 * 3. what DNS says the asked-for string is — its addresses for a name, its
 *    names for an address — matched the same two ways.
 *
 * Every host a tier finds is returned, not the first: one machine can be in
 * the tree and in an inventory both, and which of them to open is asked.
 */
export interface MatchableHost {
  /** What the host is called in the tree. */
  title: string
  /** What it is reached at: a name or an IP, without login or port. */
  host: string
}

/** What DNS said the asked-for string is. */
export interface Resolved {
  addresses: string[]
  names: string[]
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\.$/, '')
}

export function isIpAddress(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(':')
}

/** The same name, or one the other's short name. Never for addresses: 10.1 is not 10.1.2.3. */
function sameName(a: string, b: string): boolean {
  if (a === b) return true
  if (isIpAddress(a) || isIpAddress(b)) return false
  return a.startsWith(`${b}.`) || b.startsWith(`${a}.`)
}

function find<T extends MatchableHost>(
  hosts: T[],
  wanted: string[],
  test: (have: string, want: string) => boolean
): T[] {
  return hosts.filter((h) => {
    const have = [norm(h.title), norm(h.host)].filter((s) => s !== '')
    return have.some((x) => wanted.some((w) => test(x, w)))
  })
}

/** Tiers 1 and 2: what can be said without asking DNS. */
export function matchHosts<T extends MatchableHost>(query: string, hosts: T[]): T[] {
  const q = norm(query)
  if (!q) return []
  const exact = find(hosts, [q], (a, b) => a === b)
  return exact.length > 0 ? exact : find(hosts, [q], sameName)
}

/** Tier 3, once tiers 1 and 2 found nothing. */
export function matchResolved<T extends MatchableHost>(resolved: Resolved, hosts: T[]): T[] {
  const addresses = resolved.addresses.map(norm)
  const names = resolved.names.map(norm)
  return find(hosts, [...addresses, ...names], (have, want) =>
    addresses.includes(want) ? have === want : sameName(have, want)
  )
}
