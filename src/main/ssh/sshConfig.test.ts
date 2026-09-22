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

/** Three rules of ssh_config(5) the parser used to break. */
describe('parseSshConfig, as OpenSSH reads a config', () => {
  it('takes a keyword joined to its value by =', () => {
    const hosts = parseSshConfig('Host a\n  HostName=h.example\n  Port = 2222\n  User=deploy\n')
    expect(hosts[0]).toMatchObject({ hostname: 'h.example', port: 2222, user: 'deploy' })
  })

  it('does not give a host what follows a Match line', () => {
    const hosts = parseSshConfig(
      'Host web\n  HostName web.example\nMatch host *.internal\n  User admin\n'
    )
    expect(hosts).toEqual([{ alias: 'web', hostname: 'web.example', port: 22 }])
  })

  it('does not take a negated pattern for a host', () => {
    const hosts = parseSshConfig('Host !bastion prod\n  HostName p\n')
    expect(hosts.map((h) => h.alias)).toEqual(['prod'])
  })

  it('uses the first value given for a keyword', () => {
    const hosts = parseSshConfig('Host a\n  User first\n  User second\n  Port 2200\n  Port 2300\n')
    expect(hosts[0]).toMatchObject({ user: 'first', port: 2200 })
  })
})
