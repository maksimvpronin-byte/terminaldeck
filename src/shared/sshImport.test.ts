import { describe, it, expect } from 'vitest'
import { planSshImport } from './sshImport'
import type { SessionProfile, SshConfigHost } from './types'

function host(alias: string, proxyJump?: string): SshConfigHost {
  return { alias, hostname: `${alias}.example`, port: 22, proxyJump }
}

function savedHost(id: string, name: string, jumpHostId?: string): SessionProfile {
  return {
    id,
    name,
    host: `${name}.example`,
    groupId: null,
    tags: [],
    logToFile: false,
    portForwards: [],
    jumpHostId,
    createdAt: 0,
    updatedAt: 0
  } as SessionProfile
}

let n = 0
const makeId = (): string => `id-${++n}`

describe('importing hosts from ~/.ssh/config', () => {
  it('links a jump host that is imported alongside', () => {
    const plan = planSshImport([host('bastion'), host('db', 'bastion')], [], [], makeId, 1)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const [bastion, db] = plan.profiles
    expect(db.jumpHostId).toBe(bastion.id)
  })

  it('links a jump host that is already saved with the login and port the entry names', () => {
    const plan = planSshImport(
      [host('db', 'admin@bastion:2222')],
      [{ ...savedHost('saved-bastion', 'bastion'), username: 'admin', port: 2222 }],
      [],
      makeId,
      1
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('saved-bastion')
  })

  it('links a saved jump host as it is when the entry names no login or port', () => {
    const plan = planSshImport(
      [host('db', 'bastion')],
      [{ ...savedHost('saved-bastion', 'bastion'), username: 'root' }],
      [],
      makeId,
      1
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('saved-bastion')
  })

  /*
   * The saved one was linked whatever it had: admin@bastion:2222 in the
   * config went through root@bastion:22, with nothing said.
   */
  it.each([
    ['admin@bastion', 'admin@bastion:22'],
    ['bastion:2222', 'root@bastion:2222'],
    ['ssh://admin@bastion:2222', 'admin@bastion:2222']
  ])('imports nothing when %s is not how the saved jump host logs in', (spec, wanted) => {
    const plan = planSshImport(
      [host('db', spec)],
      [{ ...savedHost('saved-bastion', 'bastion'), username: 'root' }],
      [],
      makeId,
      1
    )
    expect(plan).toEqual({
      ok: false,
      problems: [
        { alias: 'db', hop: 'bastion', reason: 'differs', wanted, found: 'root@bastion:22' }
      ]
    })
  })

  /* A saved bastion with no login is reached as this machine's user, as ssh reaches it. */
  it('takes a jump host with no login as this machine’s user', () => {
    const plan = planSshImport(
      [host('db', 'max@bastion')],
      [savedHost('saved-bastion', 'bastion')],
      [],
      makeId,
      1,
      [],
      'max'
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('saved-bastion')
  })

  it('checks a jump host imported alongside the same way', () => {
    const bastion = { ...host('bastion'), user: 'root' }
    const plan = planSshImport([bastion, host('db', 'admin@bastion')], [], [], makeId, 1)
    expect(plan.ok).toBe(false)
  })

  it('reads the login of a saved jump host from its account', () => {
    const plan = planSshImport(
      [host('db', 'admin@bastion')],
      [{ ...savedHost('saved-bastion', 'bastion'), credentialId: 'acc' }],
      [],
      makeId,
      1,
      [{ id: 'acc', name: 'Admin', username: 'admin' } as never]
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('saved-bastion')
  })

  /** It used to be imported as a direct connection, with nothing said. */
  it('imports nothing when a jump host is neither chosen nor saved', () => {
    const plan = planSshImport([host('bastion-less'), host('db', 'bastion')], [], [], makeId, 1)
    expect(plan).toEqual({
      ok: false,
      problems: [{ alias: 'db', hop: 'bastion', reason: 'missing' }]
    })
  })

  it('follows a chain whose hops are each reached through the one before', () => {
    const plan = planSshImport(
      [host('j1'), host('j2', 'j1'), host('db', 'j1,j2')],
      [],
      [],
      makeId,
      1
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const [j1, j2, db] = plan.profiles
    expect(db.jumpHostId).toBe(j2.id)
    expect(j2.jumpHostId).toBe(j1.id)
  })

  /** Both hops chosen, and the chain was still dropped: db went direct. */
  it('refuses a chain it cannot follow rather than connecting direct', () => {
    const plan = planSshImport([host('j1'), host('j2'), host('db', 'j1,j2')], [], [], makeId, 1)
    expect(plan).toEqual({ ok: false, problems: [{ alias: 'db', hop: 'j2', reason: 'route' }] })
  })

  it('takes ProxyJump none as no jump host', () => {
    const plan = planSshImport([host('db', 'none')], [], [], makeId, 1)
    expect(plan.ok && plan.profiles[0].jumpHostId).toBeUndefined()
  })

  it('reads a bracketed IPv6 hop', () => {
    const plan = planSshImport(
      [host('db', 'root@[fd00::1]:22')],
      [{ ...savedHost('v6', 'fd00::1'), username: 'root' }],
      [],
      makeId,
      1
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('v6')
  })
})

/* `ProxyJump bastion` to a host whose Host line says `jump bastion` was missing, and nothing imported. */
describe('a jump host named by another of its names', () => {
  it('is found by any name its Host line gives', () => {
    const jump = { ...host('jump'), otherAliases: ['bastion'] }
    const plan = planSshImport([jump, host('app', 'bastion')], [], [], makeId, 1)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const [first, app] = plan.profiles
    expect(app.jumpHostId).toBe(first.id)
  })
})
