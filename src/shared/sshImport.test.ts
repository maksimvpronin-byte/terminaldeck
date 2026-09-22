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

  it('links a jump host that is already saved, whatever user and port the entry names', () => {
    const plan = planSshImport(
      [host('db', 'admin@bastion:2222')],
      [savedHost('saved-bastion', 'bastion')],
      [],
      makeId,
      1
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
      [savedHost('v6', 'fd00::1')],
      [],
      makeId,
      1
    )
    expect(plan.ok && plan.profiles[0].jumpHostId).toBe('v6')
  })
})
