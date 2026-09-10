import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readInventory } from './readInventory'

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
})
