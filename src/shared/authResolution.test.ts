import { describe, it, expect } from 'vitest'
import { resolveAuth, inheritedFrom } from './authResolution'
import type { SessionGroup } from './types'

const groups: SessionGroup[] = [
  { id: 'root', name: 'Infra', parentId: null, username: 'deploy', port: 2222 },
  { id: 'prod', name: 'Prod', parentId: 'root', username: 'root', secretRef: 'prod-secret' },
  { id: 'empty', name: 'Empty', parentId: 'root' }
]

describe('resolveAuth', () => {
  it('falls back to defaults with nothing set anywhere', () => {
    expect(resolveAuth({}, null, groups)).toEqual({
      port: 22,
      username: '',
      authMethod: 'password',
      privateKeyPath: undefined,
      secretRef: undefined,
      agentForward: false,
      jumpHostId: null,
      onConnectCommand: undefined,
      followTerminalCwd: false
    })
  })

  it("takes the session's own value first", () => {
    expect(resolveAuth({ username: 'mine' }, 'prod', groups).username).toBe('mine')
  })

  it('inherits from the immediate group', () => {
    expect(resolveAuth({}, 'prod', groups).username).toBe('root')
    expect(resolveAuth({}, 'prod', groups).secretRef).toBe('prod-secret')
  })

  it('walks up to a grandparent for values the parent does not set', () => {
    // 'prod' sets no port, so it comes from 'root'.
    expect(resolveAuth({}, 'prod', groups).port).toBe(2222)
  })

  it('passes straight through a group that sets nothing', () => {
    expect(resolveAuth({}, 'empty', groups).username).toBe('deploy')
  })

  it('treats an empty string as unset, so a blank field inherits', () => {
    expect(resolveAuth({ username: '' }, 'prod', groups).username).toBe('root')
  })

  it('keeps an explicit false for booleans rather than inheriting true', () => {
    const withForward: SessionGroup[] = [
      { id: 'g', name: 'g', parentId: null, agentForward: true }
    ]
    expect(resolveAuth({ agentForward: false }, 'g', withForward).agentForward).toBe(false)
    expect(resolveAuth({}, 'g', withForward).agentForward).toBe(true)
  })

  it('survives a group cycle instead of looping forever', () => {
    const cyclic: SessionGroup[] = [
      { id: 'a', name: 'a', parentId: 'b' },
      { id: 'b', name: 'b', parentId: 'a', username: 'x' }
    ]
    expect(resolveAuth({}, 'a', cyclic).username).toBe('x')
  })

  it('ignores a missing group id', () => {
    expect(resolveAuth({ username: 'own' }, 'nope', groups).username).toBe('own')
  })
})

describe('opting out of inheritance', () => {
  it('ignores the group entirely when the session opts out', () => {
    const own = { inheritAuth: false, username: 'solo' }
    expect(resolveAuth(own, 'prod', groups)).toMatchObject({
      username: 'solo',
      port: 22,
      secretRef: undefined
    })
  })

  it('falls back to defaults for fields the opted-out session leaves blank', () => {
    expect(resolveAuth({ inheritAuth: false }, 'prod', groups)).toEqual({
      port: 22,
      username: '',
      authMethod: 'password',
      privateKeyPath: undefined,
      secretRef: undefined,
      agentForward: false,
      jumpHostId: null,
      onConnectCommand: undefined,
      followTerminalCwd: false
    })
  })

  it('still inherits when the flag is explicitly true', () => {
    expect(resolveAuth({ inheritAuth: true }, 'prod', groups).username).toBe('root')
  })

  it('lets an opted-out group contribute its own values but not its parent’s', () => {
    const chain: SessionGroup[] = [
      { id: 'root', name: 'Infra', parentId: null, port: 2222, username: 'deploy' },
      { id: 'child', name: 'Child', parentId: 'root', inheritAuth: false, username: 'local' }
    ]
    const resolved = resolveAuth({}, 'child', chain)
    expect(resolved.username).toBe('local')
    // 'root' sets the port, but the walk stopped at 'child'.
    expect(resolved.port).toBe(22)
  })

  it('reports no inheritance source once opted out', () => {
    expect(inheritedFrom({ inheritAuth: false }, 'prod', groups, 'username')).toBeUndefined()
  })
})

describe('inheritedFrom', () => {
  it('names the group a blank field will take its value from', () => {
    expect(inheritedFrom({}, 'prod', groups, 'username')?.name).toBe('Prod')
    expect(inheritedFrom({}, 'prod', groups, 'port')?.name).toBe('Infra')
  })

  it('returns nothing when the value is the session own', () => {
    expect(inheritedFrom({ username: 'mine' }, 'prod', groups, 'username')).toBeUndefined()
  })

  it('returns nothing when no ancestor defines it', () => {
    expect(inheritedFrom({}, 'prod', groups, 'privateKeyPath')).toBeUndefined()
  })
})

describe('onConnectCommand', () => {
  const withCommands: SessionGroup[] = [
    { id: 'root', name: 'Infra', parentId: null, onConnectCommand: 'cd /srv' },
    { id: 'prod', name: 'Prod', parentId: 'root', onConnectCommand: 'sudo -i' },
    { id: 'plain', name: 'Plain', parentId: 'root' }
  ]

  it('is unset when nothing states one', () => {
    expect(resolveAuth({}, null, withCommands).onConnectCommand).toBeUndefined()
  })

  it('takes the nearest group, so a subgroup can replace what the parent runs', () => {
    expect(resolveAuth({}, 'prod', withCommands).onConnectCommand).toBe('sudo -i')
  })

  it('walks past a group that states none', () => {
    expect(resolveAuth({}, 'plain', withCommands).onConnectCommand).toBe('cd /srv')
  })

  it("lets a host state its own", () => {
    expect(resolveAuth({ onConnectCommand: 'tmux a' }, 'prod', withCommands).onConnectCommand).toBe(
      'tmux a'
    )
  })

  it('treats a blank field as unset, so clearing it inherits again', () => {
    expect(resolveAuth({ onConnectCommand: '' }, 'prod', withCommands).onConnectCommand).toBe(
      'sudo -i'
    )
  })

  it('is dropped along with everything else when the host opts out', () => {
    const own = { inheritAuth: false as const }
    expect(resolveAuth(own, 'prod', withCommands).onConnectCommand).toBeUndefined()
  })
})

describe('followTerminalCwd', () => {
  const groupsWithFollow: SessionGroup[] = [
    { id: 'root', name: 'Infra', parentId: null, followTerminalCwd: true },
    { id: 'quiet', name: 'Quiet', parentId: 'root', followTerminalCwd: false },
    { id: 'plain', name: 'Plain', parentId: 'root' }
  ]

  it('is off unless something asks for it', () => {
    expect(resolveAuth({}, null, groupsWithFollow).followTerminalCwd).toBe(false)
  })

  it('is inherited from a group', () => {
    expect(resolveAuth({}, 'plain', groupsWithFollow).followTerminalCwd).toBe(true)
  })

  it('lets a subgroup switch it back off, since false is a real answer', () => {
    expect(resolveAuth({}, 'quiet', groupsWithFollow).followTerminalCwd).toBe(false)
  })

  it('lets a host switch it off inside a group that wants it', () => {
    expect(
      resolveAuth({ followTerminalCwd: false }, 'plain', groupsWithFollow).followTerminalCwd
    ).toBe(false)
  })
})
