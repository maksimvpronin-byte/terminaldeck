import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { parseSshConfig } from './sshConfig'

describe('parseSshConfig', () => {
  it('reads a plain host block', () => {
    const hosts = parseSshConfig(`
Host web1
  HostName 10.0.0.5
  User deploy
  Port 2222
`)
    expect(hosts).toEqual([{ alias: 'web1', hostname: '10.0.0.5', user: 'deploy', port: 2222 }])
  })

  it('defaults the port to 22', () => {
    expect(parseSshConfig('Host a\n  HostName h\n')[0].port).toBe(22)
  })

  it('falls back to the alias when HostName is absent', () => {
    const hosts = parseSshConfig('Host example.com\n  User root\n')
    expect(hosts[0].hostname).toBe('example.com')
  })

  it('skips wildcard patterns, which configure other hosts', () => {
    const hosts = parseSshConfig(`
Host *
  ServerAliveInterval 60

Host prod?
  User root

Host real
  HostName 1.2.3.4
`)
    expect(hosts.map((h) => h.alias)).toEqual(['real'])
  })

  it('takes the first alias when several are listed', () => {
    const hosts = parseSshConfig('Host short longer.example.com\n  HostName 1.2.3.4\n')
    expect(hosts[0].alias).toBe('short')
  })

  it('ignores comments and blank lines', () => {
    const hosts = parseSshConfig(`
# a comment
Host a

  # indented comment
  HostName 1.1.1.1
`)
    expect(hosts).toEqual([{ alias: 'a', hostname: '1.1.1.1', port: 22 }])
  })

  it('is case-insensitive on keywords and tolerates = separators', () => {
    const hosts = parseSshConfig('HOST a\n  hostname = 9.9.9.9\n  USER = bob\n')
    expect(hosts[0]).toMatchObject({ hostname: '9.9.9.9', user: 'bob' })
  })

  it('expands ~ in IdentityFile and strips quotes', () => {
    const hosts = parseSshConfig('Host a\n  HostName h\n  IdentityFile "~/.ssh/id_ed25519"\n')
    expect(hosts[0].identityFile).toBe(join(homedir(), '/.ssh/id_ed25519'))
  })

  it('captures ProxyJump', () => {
    const hosts = parseSshConfig('Host a\n  HostName h\n  ProxyJump bastion\n')
    expect(hosts[0].proxyJump).toBe('bastion')
  })

  it('separates consecutive host blocks', () => {
    const hosts = parseSshConfig('Host a\n  HostName 1\nHost b\n  HostName 2\n')
    expect(hosts.map((h) => h.hostname)).toEqual(['1', '2'])
  })

  it('returns nothing for an empty config', () => {
    expect(parseSshConfig('')).toEqual([])
  })

  it('ignores directives that appear before any Host block', () => {
    const hosts = parseSshConfig('Compression yes\nHost a\n  HostName h\n')
    expect(hosts).toEqual([{ alias: 'a', hostname: 'h', port: 22 }])
  })
})
