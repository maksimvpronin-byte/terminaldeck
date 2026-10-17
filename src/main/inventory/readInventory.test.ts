import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { readInventory } from './readInventory'
import { reallyInsideCheckout } from './checkout'

describe('inventory worker parsing', () => {
  it('keeps first host values, unions membership, reads vars and attaches roots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-inventory-'))
    try {
      writeFileSync(
        join(dir, 'a.yml'),
        'prod:\n  hosts:\n    shared:\n      ansible_host: 10.0.0.1\n'
      )
      writeFileSync(
        join(dir, 'b.yml'),
        'dev:\n  hosts:\n    shared:\n      ansible_host: 10.0.0.2\n'
      )
      mkdirSync(join(dir, 'host_vars'))
      writeFileSync(join(dir, 'host_vars/shared.yml'), 'ansible_user: deploy\n')
      const result = readInventory({
        dir,
        paths: ['a.yml', 'b.yml'],
        sourceId: 'repo',
        prefix: 'git',
        rootId: 'root'
      })
      expect(result.hosts).toHaveLength(1)
      expect(result.hosts[0]).toMatchObject({ host: '10.0.0.1', username: 'deploy' })
      expect(result.groups.every((g) => g.parentId === 'root')).toBe(true)
      // In Ansible's order, whichever file named the group first.
      expect(result.memberships[result.hosts[0].id]).toEqual(['git:repo:g:dev', 'git:repo:g:prod'])
      expect(result.files).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * A host name is a YAML key from the repository, and `../../outside` is a
   * valid one. Joined into `host_vars/` it read a vars file from beside the
   * checkout and presented its contents as settings for the host.
   */
  it('does not read vars from outside the checkout by a host name', () => {
    const top = mkdtempSync(join(tmpdir(), 'td-inventory-'))
    try {
      const repo = join(top, 'repo')
      mkdirSync(join(repo, 'host_vars'), { recursive: true })
      writeFileSync(join(top, 'outside.yml'), 'ansible_user: stolen\n')
      writeFileSync(
        join(repo, 'hosts.yml'),
        'all:\n  hosts:\n    "../../outside":\n      ansible_host: 10.0.0.3\n'
      )

      const result = readInventory({
        dir: repo,
        paths: ['hosts.yml'],
        sourceId: 'repo',
        prefix: 'git',
        rootId: 'root'
      })

      expect(result.hosts).toHaveLength(1)
      expect(result.hosts[0].username).not.toBe('stolen')
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })

  /**
   * Cloning recreates a committed link. A junction, because that is the link
   * Windows lets anybody make; elsewhere it is an ordinary directory symlink.
   */
  it('does not follow a link in the checkout to vars outside it', () => {
    const top = mkdtempSync(join(tmpdir(), 'td-inventory-'))
    try {
      const repo = join(top, 'repo')
      const secrets = join(top, 'secrets')
      mkdirSync(join(repo, 'host_vars'), { recursive: true })
      mkdirSync(secrets)
      writeFileSync(join(secrets, 'creds.yml'), 'ansible_user: stolen\n')
      symlinkSync(secrets, join(repo, 'host_vars', 'web'), 'junction')
      writeFileSync(
        join(repo, 'hosts.yml'),
        'all:\n  hosts:\n    web:\n      ansible_host: 10.0.0.4\n'
      )

      const result = readInventory({
        dir: repo,
        paths: ['hosts.yml'],
        sourceId: 'repo',
        prefix: 'git',
        rootId: 'root'
      })

      expect(result.hosts[0].username).not.toBe('stolen')
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })
})

describe('reallyInsideCheckout', () => {
  it('judges a link by where it lands', () => {
    const top = mkdtempSync(join(tmpdir(), 'td-checkout-'))
    try {
      const repo = join(top, 'repo')
      mkdirSync(join(repo, 'inside'), { recursive: true })
      mkdirSync(join(top, 'outside'))
      symlinkSync(join(top, 'outside'), join(repo, 'link'), 'junction')

      expect(reallyInsideCheckout(repo, join(repo, 'inside'))).toBe(true)
      expect(reallyInsideCheckout(repo, join(repo, 'missing.yml'))).toBe(true)
      expect(reallyInsideCheckout(repo, join(repo, 'link'))).toBe(false)
      expect(reallyInsideCheckout(repo, join(repo, '..', 'outside'))).toBe(false)
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })
})

it('reports a broken vars file instead of silently dropping connection settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'td-vars-'))
  try {
    mkdirSync(join(dir, 'host_vars'))
    writeFileSync(join(dir, 'hosts.yml'), 'all:\n  hosts:\n    web:\n')
    writeFileSync(join(dir, 'host_vars/web.yml'), 'ansible_user: [unfinished')
    expect(() =>
      readInventory({ dir, paths: ['hosts.yml'], sourceId: 'repo', prefix: 'git', rootId: 'root' })
    ).toThrow(/Cannot read inventory variables.*web.yml/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('skips a vars file encrypted with ansible-vault and keeps syncing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'td-vars-'))
  try {
    mkdirSync(join(dir, 'group_vars/all'), { recursive: true })
    writeFileSync(join(dir, 'hosts.yml'), 'all:\n  hosts:\n    web:\n')
    writeFileSync(join(dir, 'group_vars/all/main.yml'), 'ansible_user: deploy\n')
    writeFileSync(
      join(dir, 'group_vars/all/vault.yml'),
      '$ANSIBLE_VAULT;1.1;AES256\n61626364656667686970\n6a6b6c6d6e6f70717273\n'
    )
    const result = readInventory({
      dir,
      paths: ['hosts.yml'],
      sourceId: 'repo',
      prefix: 'git',
      rootId: 'root'
    })
    expect(result.hosts.map((h) => h.name)).toEqual(['web'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * To Ansible a group is its name, wherever and in whichever file it is
 * written; each of these lost the login a host should have inherited.
 */
describe('a group written down in more than one place', () => {
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'td-inventory-'))
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), body)
    }
    return dir
  }

  /** The login a host ends up with: its own, or the nearest group's above it. */
  function loginOf(result: ReturnType<typeof readInventory>, host: string): string | undefined {
    const found = result.hosts.find((h) => h.name === host)!
    if (found.username) return found.username
    const byId = new Map(result.groups.map((g) => [g.id, g]))
    for (let g = byId.get(found.groupId!); g; g = g.parentId ? byId.get(g.parentId) : undefined) {
      if (g.username) return g.username
    }
    return undefined
  }

  function read(dir: string, paths: string[]): ReturnType<typeof readInventory> {
    try {
      return readInventory({ dir, paths, sourceId: 'repo', prefix: 'inv', rootId: 'root' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('gives the hosts of a group named as a child the login of its parent', () => {
    const result = read(
      repo({
        'hosts.yml': [
          'all:',
          '  children:',
          '    prod:',
          '      vars:',
          '        ansible_user: deploy',
          '      children:',
          '        web: {}',
          '    web:',
          '      hosts:',
          '        web1: {}',
          ''
        ].join('\n')
      }),
      ['hosts.yml']
    )
    expect(loginOf(result, 'web1')).toBe('deploy')
    // Shown under both places web is written, as Ansible counts it in both.
    expect(result.memberships['inv:repo:h:web1']).toEqual([
      'inv:repo:g:all/web',
      'inv:repo:g:all/prod/web'
    ])
  })

  it('takes a group’s vars from a later file as well as the first', () => {
    const result = read(
      repo({
        'a.yml': 'web: {}\n',
        'b.yml': 'web:\n  vars:\n    ansible_user: deploy\n  hosts:\n    web1: {}\n'
      }),
      ['a.yml', 'b.yml']
    )
    expect(result.groups.filter((g) => g.name === 'web')).toHaveLength(1)
    expect(loginOf(result, 'web1')).toBe('deploy')
  })

  it('applies group_vars/all.yml to a file that never names all', () => {
    const result = read(
      repo({
        'hosts.yml': 'web:\n  hosts:\n    web1: {}\n',
        'group_vars/all.yml': 'ansible_user: deploy\nansible_port: 2222\n'
      }),
      ['hosts.yml']
    )
    expect(loginOf(result, 'web1')).toBe('deploy')
    // The group keeps its place, and its own vars still win over all's.
    expect(result.groups.map((g) => g.id)).toEqual(['inv:repo:g:web'])
  })

  /** Ansible reads the group_vars and host_vars beside each file for the whole inventory. */
  it('reads group_vars and host_vars beside every file, not just the first', () => {
    const result = read(
      repo({
        'one/hosts.yml': 'web:\n  hosts:\n    web1: {}\n',
        'two/hosts.yml': 'web:\n  hosts:\n    web2: {}\n',
        'two/group_vars/web.yml': 'ansible_user: deploy\n',
        'two/host_vars/web1.yml': 'ansible_port: 2222\n'
      }),
      ['one/hosts.yml', 'two/hosts.yml']
    )
    expect(loginOf(result, 'web1')).toBe('deploy')
    expect(loginOf(result, 'web2')).toBe('deploy')
    expect(result.hosts.find((h) => h.name === 'web1')?.port).toBe(2222)
  })

  it('reads host_vars beside the second file for a host it names too', () => {
    const result = read(
      repo({
        'one/hosts.yml': 'web:\n  hosts:\n    web1: {}\n',
        'two/hosts.yml': 'db:\n  hosts:\n    web1: {}\n',
        'two/host_vars/web1.yml': 'ansible_user: deploy\n'
      }),
      ['one/hosts.yml', 'two/hosts.yml']
    )
    expect(result.hosts.find((h) => h.name === 'web1')?.username).toBe('deploy')
  })

  it('carries all’s vars from one file to the groups of a file without all', () => {
    const result = read(
      repo({
        'a.yml': 'all:\n  vars:\n    ansible_user: deploy\n',
        'b.yml': 'web:\n  hosts:\n    web1: {}\n'
      }),
      ['a.yml', 'b.yml']
    )
    expect(loginOf(result, 'web1')).toBe('deploy')
  })

  it('carries a parent’s login through a child whose children are given elsewhere', () => {
    const result = read(
      repo({
        'hosts.yml': [
          'all:',
          '  children:',
          '    prod:',
          '      vars:',
          '        ansible_user: deploy',
          '      children:',
          '        web: {}',
          '    web:',
          '      children:',
          '        leaf:',
          '          hosts:',
          '            h1: {}',
          ''
        ].join('\n')
      }),
      ['hosts.yml']
    )
    expect(loginOf(result, 'h1')).toBe('deploy')
    expect(result.groups.map((g) => g.id)).toContain('inv:repo:g:all/prod/web/leaf')
  })

  it('stops at a group that is its own ancestor', () => {
    const result = read(
      repo({
        'hosts.yml':
          'a:\n  children:\n    b:\n      hosts:\n        h1: {}\nb:\n  children:\n    a: {}\n'
      }),
      ['hosts.yml']
    )
    expect(result.hosts.map((h) => h.name)).toEqual(['h1'])
    expect(result.groups.length).toBeLessThan(10)
  })

  it('lets a group’s own vars win over group_vars/all without an all key', () => {
    const result = read(
      repo({
        'hosts.yml': 'web:\n  vars:\n    ansible_user: www\n  hosts:\n    web1: {}\n',
        'group_vars/all.yml': 'ansible_user: deploy\n'
      }),
      ['hosts.yml']
    )
    expect(loginOf(result, 'web1')).toBe('www')
  })
})
