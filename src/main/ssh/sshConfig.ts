import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, existsSync } from 'fs'

import type { SshConfigHost } from '../../shared/types'

export type { SshConfigHost }

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function configPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/**
 * Parses ~/.ssh/config well enough to seed session profiles. Patterns containing
 * wildcards are skipped: they configure other hosts rather than name one.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = []
  let current: SshConfigHost | null = null

  const flush = (): void => {
    // Blocks without an explicit HostName are kept; the alias stands in for it below.
    if (current) hosts.push(current)
    current = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const match = line.match(/^(\S+)\s+(.*)$/)
    if (!match) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim().replace(/^=\s*/, '')

    if (keyword === 'host') {
      flush()
      const aliases = value.split(/\s+/).filter((a) => !a.includes('*') && !a.includes('?'))
      if (aliases.length === 0) continue
      current = { alias: aliases[0], hostname: '', port: 22 }
      continue
    }

    if (!current) continue

    switch (keyword) {
      case 'hostname':
        current.hostname = value
        break
      case 'user':
        current.user = value
        break
      case 'port':
        current.port = Number(value) || 22
        break
      case 'identityfile':
        current.identityFile = expandHome(value.replace(/^["']|["']$/g, ''))
        break
      case 'proxyjump':
        current.proxyJump = value
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
