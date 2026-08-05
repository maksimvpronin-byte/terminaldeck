import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { parseAnsibleInventory, varsToAuth, groupId, hostId } from './ansible'

const SRC = 'src1'

describe('varsToAuth', () => {
  it('maps the connection vars we understand', () => {
    expect(
      varsToAuth({ ansible_user: 'deploy', ansible_port: 2222 })
    ).toEqual({ username: 'deploy', port: 2222 })
  })

  it('accepts the ansible_ssh_* aliases', () => {
    expect(varsToAuth({ ansible_ssh_user: 'root', ansible_ssh_port: '2200' })).toEqual({
      username: 'root',
      port: 2200
    })
  })

  it('infers key auth from a stated key file', () => {
    expect(varsToAuth({ ansible_ssh_private_key_file: '/k/id' })).toEqual({
      privateKeyPath: '/k/id',
      authMethod: 'privateKey'
    })
  })

  it('sets nothing for unrelated or blank vars', () => {
    expect(varsToAuth({ some_var: 'x', ansible_user: '   ' })).toEqual({})
  })
})

describe('parseAnsibleInventory', () => {
  const doc = parse(`
all:
  children:
    web:
      hosts:
        web1:
          ansible_host: 10.0.0.1
        web2: {}
      vars:
        ansible_user: nginx
    db:
      hosts:
        db1:
          ansible_host: 10.0.0.9
          ansible_user: postgres
          ansible_port: 2222
`)

  it('builds a group per Ansible group, nested under all', () => {
    const { groups } = parseAnsibleInventory(doc, SRC)
    expect(groups.map((g) => g.name)).toEqual(['all', 'web', 'db'])
    expect(groups.find((g) => g.name === 'web')!.parentId).toBe(groupId(SRC, 'all'))
  })

  it('puts group vars on the group, so hosts inherit them', () => {
    const { groups } = parseAnsibleInventory(doc, SRC)
    expect(groups.find((g) => g.name === 'web')!.username).toBe('nginx')
  })

  it('reads ansible_host, falling back to the host key', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    expect(hosts.find((h) => h.name === 'web1')!.host).toBe('10.0.0.1')
    expect(hosts.find((h) => h.name === 'web2')!.host).toBe('web2')
  })

  it('leaves host auth unset when the inventory says nothing, so it inherits', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    expect(hosts.find((h) => h.name === 'web1')!.username).toBeUndefined()
  })

  it('keeps host-level overrides', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    const db1 = hosts.find((h) => h.name === 'db1')!
    expect(db1.username).toBe('postgres')
    expect(db1.port).toBe(2222)
  })

  it('gives hosts stable ids derived from the source', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    expect(hosts.find((h) => h.name === 'db1')!.id).toBe(hostId(SRC, 'db1'))
  })

  it('merges group_vars and host_vars, with inline vars winning', () => {
    const lookup = (kind: 'group' | 'host', name: string): Record<string, unknown> => {
      if (kind === 'group' && name === 'web') return { ansible_user: 'from-group-vars' }
      if (kind === 'host' && name === 'db1') return { ansible_user: 'from-host-vars' }
      return {}
    }
    const { groups, hosts } = parseAnsibleInventory(doc, SRC, lookup)
    // Inline `vars:` beats group_vars, as in Ansible.
    expect(groups.find((g) => g.name === 'web')!.username).toBe('nginx')
    // db1 states its own user inline, so host_vars loses too.
    expect(hosts.find((h) => h.name === 'db1')!.username).toBe('postgres')
  })

  it('applies host_vars when the inventory states nothing inline', () => {
    // web2 declares no vars of its own, unlike web1 which sets ansible_host.
    const lookup = (kind: 'group' | 'host', name: string): Record<string, unknown> =>
      kind === 'host' && name === 'web2' ? { ansible_host: '192.168.1.5' } : {}
    const { hosts } = parseAnsibleInventory(doc, SRC, lookup)
    expect(hosts.find((h) => h.name === 'web2')!.host).toBe('192.168.1.5')
  })

  it('assigns a host listed twice to the first group that claims it', () => {
    const dup = parse(`
all:
  children:
    a:
      hosts:
        shared: {}
    b:
      hosts:
        shared: {}
`)
    const { hosts } = parseAnsibleInventory(dup, SRC)
    expect(hosts).toHaveLength(1)
    expect(hosts[0].groupId).toBe(groupId(SRC, 'all/a'))
  })

  it('handles top-level groups without an "all" wrapper', () => {
    const flat = parse('web:\n  hosts:\n    w1: {}\n')
    const { groups, hosts } = parseAnsibleInventory(flat, SRC)
    expect(groups.map((g) => g.name)).toEqual(['web'])
    expect(hosts.map((h) => h.name)).toEqual(['w1'])
  })

  it('tolerates empty and null sections', () => {
    const sparse = parse('all:\n  children:\n    empty:\n')
    expect(() => parseAnsibleInventory(sparse, SRC)).not.toThrow()
    expect(parseAnsibleInventory(sparse, SRC).hosts).toEqual([])
  })

  it('returns nothing for a non-object document', () => {
    expect(parseAnsibleInventory(null, SRC)).toEqual({ groups: [], hosts: [] })
    expect(parseAnsibleInventory('text', SRC)).toEqual({ groups: [], hosts: [] })
  })
})
