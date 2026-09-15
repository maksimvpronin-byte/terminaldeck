import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
      expect(result.memberships[result.hosts[0].id]).toEqual(result.groups.map((g) => g.id))
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
