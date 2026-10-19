import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
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

it('strips inline comments while preserving hashes in quoted paths', () => {
  const hosts = parseSshConfig(
    'Host prod # production\n  User deploy # login\n  Port 2222 # alternate\n  IdentityFile "~/.ssh/key#prod" # key\n'
  )
  expect(hosts[0]).toMatchObject({
    user: 'deploy',
    port: 2222,
    identityFile: join(homedir(), '.ssh/key#prod')
  })
})
it('keeps a hash in the middle of an unquoted path, as OpenSSH does', () => {
  const hosts = parseSshConfig('Host prod\n  IdentityFile ~/.ssh/key#prod #comment\n')
  expect(hosts[0].identityFile).toBe(join(homedir(), '.ssh/key#prod'))
})
it.each(['-1', '65536', '22.5', 'Infinity', 'nonsense'])(
  'reports invalid port %s instead of importing the wrong port',
  (port) => {
    expect(() => parseSshConfig(`Host prod\n  Port ${port}\n`)).toThrow('Invalid SSH port')
  }
)

/*
 * A block of patterns configures the hosts it matches, and was skipped
 * whole: `Host * !bastion` giving every host but the bastion its login, port
 * and jump host left them all on 22, as nobody, connecting direct — where
 * `ssh -G prod` says deploy, 2222 and through bastion.
 */
describe('a block of patterns', () => {
  it('gives the hosts it matches what it says, the first value winning', () => {
    const hosts = parseSshConfig(
      [
        'Host prod',
        '  HostName 10.0.0.10',
        'Host bastion',
        '  HostName bastion.example',
        'Host * !bastion',
        '  User deploy',
        '  Port 2222',
        '  ProxyJump bastion',
        'Host *',
        '  User fallback'
      ].join('\n')
    )
    expect(hosts.find((h) => h.alias === 'prod')).toMatchObject({
      hostname: '10.0.0.10',
      user: 'deploy',
      port: 2222,
      proxyJump: 'bastion'
    })
    // Not matched by `* !bastion`; only `Host *` speaks for it.
    const bastion = hosts.find((h) => h.alias === 'bastion')
    expect(bastion).toMatchObject({ hostname: 'bastion.example', user: 'fallback', port: 22 })
    expect(bastion?.proxyJump).toBeUndefined()
  })

  it('lets a host’s own block, read first, win over a pattern after it', () => {
    const hosts = parseSshConfig(
      ['Host web', '  Port 2200', 'Host w*', '  Port 22', '  User ops'].join('\n')
    )
    expect(hosts[0]).toMatchObject({ alias: 'web', port: 2200, user: 'ops' })
  })
})

/* Every plain name on a Host line names the host, as ssh reads it, not the first alone. */
describe('a Host line of several names', () => {
  /* Without a HostName, `Host prod staging` is two servers sharing settings. */
  it('makes each name its own host when no HostName says they are one', () => {
    const hosts = parseSshConfig('Host prod.example.com staging.example.com\n  User deploy\n')
    expect(hosts).toEqual([
      { alias: 'prod.example.com', hostname: 'prod.example.com', port: 22, user: 'deploy' },
      { alias: 'staging.example.com', hostname: 'staging.example.com', port: 22, user: 'deploy' }
    ])
  })

  it('keeps the other names of the host', () => {
    const hosts = parseSshConfig('Host jump bastion\n  HostName bastion.example\n')
    expect(hosts).toEqual([
      { alias: 'jump', otherAliases: ['bastion'], hostname: 'bastion.example', port: 22 }
    ])
  })
})

/* OpenSSH tries every IdentityFile and passes over the ones that are not there. */
describe('several IdentityFile lines', () => {
  it('give the host the first key that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-sshkeys-'))
    try {
      const present = join(dir, 'id_ed25519')
      writeFileSync(present, 'key')
      const hosts = parseSshConfig(
        `Host web\n  IdentityFile ${join(dir, 'id_rsa')}\n  IdentityFile ${present}\n`
      )
      expect(hosts[0].identityFile).toBe(present)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
