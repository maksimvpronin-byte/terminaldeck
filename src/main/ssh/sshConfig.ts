import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

import type { SshConfigHost } from '../../shared/types'

export type { SshConfigHost }

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

/**
 * OpenSSH starts a comment only with a hash that begins a word, so a hash in a
 * quoted key path, or in the middle of an unquoted one, is part of the path.
 */
function stripComment(line: string): string {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") quote = char
    else if (char === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function configPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/** One `Host` line and what follows it, or the lines before any; a `Match` block has no patterns. */
interface Block {
  patterns: string[] | null
  settings: Array<[keyword: string, value: string]>
}

/** `*` and `?` as ssh_config(5) has them, case aside. */
function globMatches(pattern: string, name: string): boolean {
  const source = pattern
    .split('')
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${source}$`, 'i').test(name)
}

/** Whether a block speaks for `alias`: a pattern matches it and no negated one does. */
function applies(block: Block, alias: string): boolean {
  if (block.patterns === null) return false
  const negated = block.patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  if (negated.some((p) => globMatches(p, alias))) return false
  return block.patterns.some((p) => !p.startsWith('!') && globMatches(p, alias))
}

const isPattern = (token: string): boolean =>
  token.includes('*') || token.includes('?') || token.startsWith('!')

/**
 * Parses ~/.ssh/config well enough to seed session profiles. A block whose
 * `Host` names a host with no pattern is one to import; every block whose
 * patterns match that name — `Host *`, `Host * !bastion` — gives it settings
 * too, the first value for each keyword winning, in the order they come.
 * Pattern blocks were skipped whole, and with them the login, port and jump
 * host they gave: `ssh -G prod` said deploy on 2222 through bastion, and the
 * import connected as nobody on 22, direct.
 *
 * Three more rules of ssh_config(5) it follows, each of which it used to break:
 *
 * - A keyword and its value may be joined by `=` with no space around it:
 *   `HostName=example.com`. Those lines were taken for a keyword with no value
 *   and dropped.
 * - A `Match` line ends the `Host` block above it, and what it selects is not
 *   known here, so nothing in it is given to anyone. What followed a Match was
 *   applied to the host above it, so a `User` meant for some other set of
 *   machines became its login.
 * - The first value given for a keyword is the one used; later ones are ignored.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const blocks: Block[] = [{ patterns: ['*'], settings: [] }]
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (line === '' || line.startsWith('#')) continue
    const match = line.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()
    if (keyword === 'host') {
      blocks.push({ patterns: value.split(/\s+/).map(unquote), settings: [] })
    } else if (keyword === 'match') {
      blocks.push({ patterns: null, settings: [] })
    } else {
      blocks[blocks.length - 1].settings.push([keyword, value])
    }
  }

  /** One name as OpenSSH resolves it: its own block and every pattern that matches it. */
  const resolve = (alias: string, block: Block): { host: SshConfigHost; named: boolean } => {
    const host: SshConfigHost = { alias, hostname: '', port: 22 }
    const taken = new Set<string>()
    const keys: string[] = []
    for (const from of blocks) {
      if (from !== block && !applies(from, alias)) continue
      for (const [keyword, value] of from.settings) {
        // Every IdentityFile counts, as OpenSSH tries each in turn.
        if (keyword === 'identityfile') {
          keys.push(expandHome(unquote(value)))
          continue
        }
        if (taken.has(keyword)) continue
        switch (keyword) {
          case 'hostname':
            host.hostname = unquote(value)
            break
          case 'user':
            host.user = unquote(value)
            break
          case 'port': {
            const port = Number(unquote(value))
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              throw new Error(`Invalid SSH port for ${alias}: ${value}`)
            }
            host.port = port
            break
          }
          case 'proxyjump':
            host.proxyJump = value
            break
          default:
            continue
        }
        taken.add(keyword)
      }
    }
    /*
     * A host keeps one key, and the first OpenSSH would get anywhere with is
     * the first that exists: it passes over the ones that do not, and a
     * `Host *` listing id_rsa then id_ed25519 for a machine with only the
     * second gave the import a key that was not there.
     */
    const key = keys.find((path) => existsSync(path)) ?? keys[0]
    if (key) host.identityFile = key
    const named = host.hostname !== ''
    // A Host block without an explicit HostName resolves to the alias itself.
    return { host: { ...host, hostname: host.hostname || host.alias }, named }
  }

  const hosts: SshConfigHost[] = []
  const add = (host: SshConfigHost): void => {
    if (!hosts.some((h) => h.alias === host.alias)) hosts.push(host)
  }
  for (const block of blocks.slice(1)) {
    const [alias, ...others] = block.patterns?.filter((p) => !isPattern(p)) ?? []
    if (!alias) continue
    const first = resolve(alias, block)
    /*
     * Several names on one Host line are one machine only when it says which:
     * with a HostName they are its other names, and a ProxyJump naming any of
     * them finds it. Without one, each name is the machine of that name —
     * `Host prod staging` is two servers sharing settings, and the second was
     * missing from the import.
     */
    if (first.named || others.length === 0) {
      add(others.length > 0 ? { ...first.host, otherAliases: others } : first.host)
      continue
    }
    add(first.host)
    for (const other of others) add(resolve(other, block).host)
  }
  return hosts
}

export function readSshConfigHosts(): SshConfigHost[] {
  const p = configPath()
  if (!existsSync(p)) return []
  try {
    return parseSshConfig(readFileSync(p, 'utf8'))
  } catch (err) {
    throw new Error(`Cannot read SSH configuration ${p}: ${(err as Error).message}`)
  }
}
