import { describe, it, expect } from 'vitest'
import { applyCredential } from './credentials'
import { resolveAuth } from './authResolution'
import type { Credential, SessionGroup } from './types'

const groups: SessionGroup[] = [
  {
    id: 'prod',
    name: 'Prod',
    parentId: null,
    username: 'deploy',
    port: 2222,
    secretRef: 'group-secret',
    authMethod: 'privateKey',
    privateKeyPath: '/keys/deploy',
    onConnectCommand: 'sudo -i'
  }
]

const admin: Credential = {
  id: 'cred-1',
  name: 'domain admin',
  username: 'CORP\\admin',
  authMethod: 'password',
  secretRef: 'admin-secret',
  createdAt: 0,
  updatedAt: 0
}

describe('applyCredential', () => {
  it('leaves the resolution alone when no account was chosen', () => {
    const auth = resolveAuth({}, 'prod', groups)
    expect(applyCredential(auth, undefined)).toEqual(auth)
  })

  it('replaces who you are without touching where the host is', () => {
    const auth = applyCredential(resolveAuth({}, 'prod', groups), admin)
    expect(auth.username).toBe('CORP\\admin')
    expect(auth.authMethod).toBe('password')
    expect(auth.secretRef).toBe('admin-secret')
    // The host's own routing and habits survive: an account says who, not where.
    expect(auth.port).toBe(2222)
    expect(auth.onConnectCommand).toBe('sudo -i')
  })

  it('never falls back to the host password when the account saved none', () => {
    // The whole reason this replaces all four fields together. Falling back
    // would offer one account's name with another account's password.
    const typedEachTime: Credential = { ...admin, secretRef: undefined }
    const auth = applyCredential(resolveAuth({}, 'prod', groups), typedEachTime)
    expect(auth.secretRef).toBeUndefined()
  })

  it('drops a key path the account does not state', () => {
    // The group authenticates with a key file; the account with a password.
    // Keeping the group's path would leave a key hanging off a password login.
    const auth = applyCredential(resolveAuth({}, 'prod', groups), admin)
    expect(auth.privateKeyPath).toBeUndefined()
  })

  it('carries the account own key file across', () => {
    const keyed: Credential = {
      ...admin,
      authMethod: 'privateKey',
      privateKeyPath: '/keys/admin',
      secretRef: 'admin-passphrase'
    }
    const auth = applyCredential(resolveAuth({}, 'prod', groups), keyed)
    expect(auth.privateKeyPath).toBe('/keys/admin')
    expect(auth.secretRef).toBe('admin-passphrase')
  })
})
