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

function configPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/**
 * Parses ~/.ssh/config well enough to seed session profiles. Patterns containing
 * wildcards are skipped: they configure other hosts rather than name one, and so
 * are negated ones (`!bastion`), which name a host only to exclude it.
 *
 * Three rules of ssh_config(5) it follows, each of which it used to break:
 *
 * - A keyword and its value may be joined by `=` with no space around it:
 *   `HostName=example.com`. Those lines were taken for a keyword with no value
 *   and dropped.
 * - A `Match` line ends the `Host` block above it. What followed a Match was
 *   applied to that host, so a `User` meant for some other set of machines
 *   became its login.
 * - The first value given for a keyword is the one used; later ones in the
 *   same block are ignored.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost | null = null
  let portSet = false

  const flush = (): void => {
    // Blocks without an explicit HostName are kept; the alias stands in for it below.
    if (current) hosts.push(current)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = line.match(/^([^\s=]+)\s*(?:=\s*|\s+)(.*)$/)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()

    if (keyword === 'host') {
      flush()
      const aliases = value
        .split(/\s+/)
        .filter((a) => !a.includes('*') && !a.includes('?') && !a.startsWith('!'))
      if (aliases.length === 0) continue
      current = { alias: unquote(aliases[0]), hostname: '', port: 22 }
      portSet = false
      continue
    }
    if (keyword === 'match') {
      // What follows belongs to whatever the Match selects, not to this host.
      flush()
      continue
    }

    if (!current) continue
    const host: SshConfigHost = current

    switch (keyword) {
      case 'hostname':
        if (!host.hostname) host.hostname = unquote(value)
        break
      case 'user':
        host.user ??= unquote(value)
        break
      case 'port':
        if (!portSet) {
          host.port = Number(value) || 22
          portSet = true
        }
        break
      case 'identityfile':
        host.identityFile ??= expandHome(unquote(value))
        break
      case 'proxyjump':
        host.proxyJump ??= value
        break
      default:
        break
    }
  }
  flush()

  // A Host block without an explicit HostName resolves to the alias itself.
  return hosts.map((h) => ({ ...h, hostname: h.hostname || h.alias }))
}

export function readSshConfigHosts(): SshConfigHost[] {
  const p = configPath()
  if (!existsSync(p)) return []
  try {
    return parseSshConfig(readFileSync(p, 'utf8'))
  } catch {
    return []
  }
}
