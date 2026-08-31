import { describe, it, expect } from 'vitest'
import { authFieldsState, secretToSave } from './authFields'
import type { AuthDefaults, SessionGroup } from './types'

const groups: SessionGroup[] = [
  {
    id: 'prod',
    name: 'Production',
    parentId: null,
    username: 'ops',
    port: 2222,
    authMethod: 'password',
    secretRef: 'secret-prod'
  },
  {
    id: 'db',
    name: 'Databases',
    parentId: 'prod',
    privateKeyPath: '/keys/db'
  }
]

/** A host in `Databases`, holding whatever the test gives it. */
function host(own: AuthDefaults = {}): Parameters<typeof authFieldsState>[0] {
  return { own, parentId: 'db', groups, forgetSecret: false }
}

describe('the credential fields of an editing dialog', () => {
  it('shows what a blank field would be inherited as', () => {
    const state = authFieldsState(host())

    expect(state.effective.username).toBe('ops')
    expect(state.effective.port).toBe(2222)
    expect(state.inheritedFrom('username')?.name).toBe('Production')
  })

  it('lets the item to hand win', () => {
    const state = authFieldsState(host({ username: 'root', port: 22 }))

    expect(state.effective.username).toBe('root')
    expect(state.effective.port).toBe(22)
    // Nothing to inherit: it is set here.
    expect(state.inheritedFrom('username')).toBeUndefined()
  })

  it('names the nearest group a field comes from, not the furthest', () => {
    expect(authFieldsState(host()).inheritedFrom('privateKeyPath')?.name).toBe('Databases')
  })

  /** What the "inherit" option offers, which is not what the item is doing now. */
  it('says what the method would fall back to, not what it is', () => {
    const state = authFieldsState(host({ authMethod: 'agent' }))

    expect(state.shownMethod).toBe('agent')
    expect(state.inheritedMethod).toBe('password')
  })

  describe('a credential the item holds itself', () => {
    it('is reported as its own, and an inherited one is not', () => {
      expect(authFieldsState(host({ secretRef: 'secret-host' })).ownSecret).toBe(true)
      expect(authFieldsState(host()).ownSecret).toBe(false)
    })

    /** The dialog says what it would fall back to before anyone saves. */
    it('gives way to the inherited one as soon as forgetting is pending', () => {
      const own = { secretRef: 'secret-host' }

      expect(authFieldsState({ ...host(own) }).effective.secretRef).toBe('secret-host')
      expect(authFieldsState({ ...host(own), forgetSecret: true }).effective.secretRef).toBe(
        'secret-prod'
      )
    })

    it('is still reported as its own while the forget is only pending', () => {
      const state = authFieldsState({ ...host({ secretRef: 'secret-host' }), forgetSecret: true })

      // It is what makes the "keep it" offer sensible: nothing is gone yet.
      expect(state.ownSecret).toBe(true)
    })
  })

  describe('a key file and its passphrase coming from different places', () => {
    it('is flagged', () => {
      const state = authFieldsState(host({ authMethod: 'privateKey', secretRef: 'secret-host' }))

      // The key is the group's, the passphrase is the host's.
      expect(state.splitCredential).toBe(true)
    })

    it('is not flagged when both come from the same place', () => {
      const state = authFieldsState(
        host({ authMethod: 'privateKey', privateKeyPath: '/keys/own', secretRef: 'secret-host' })
      )

      expect(state.splitCredential).toBe(false)
    })

    it('is not flagged for a method that has no key file', () => {
      const state = authFieldsState(host({ authMethod: 'password', secretRef: 'secret-host' }))

      expect(state.splitCredential).toBe(false)
    })

    it('says where each of the two came from, so the warning can name them', () => {
      const state = authFieldsState(host({ authMethod: 'privateKey', secretRef: 'secret-host' }))

      expect(state.passphraseFrom).toBe('self')
      expect(state.keyFrom).not.toBe('self')
      expect(state.keyFrom).toHaveProperty('name', 'Databases')
    })
  })

  /**
   * An inventory override edits a host that came from a repository, so its
   * settings sit between the override and the groups.
   */
  describe('an override on top of an inventory host', () => {
    const beneath: AuthDefaults = { username: 'ansible', authMethod: 'privateKey' }

    it('shows the repository’s value where the override states nothing', () => {
      const state = authFieldsState({
        own: {},
        beneath,
        parentId: 'db',
        groups,
        forgetSecret: false
      })

      expect(state.effective.username).toBe('ansible')
      expect(state.shownMethod).toBe('privateKey')
    })

    it('offers the repository’s method as what handing it back would give', () => {
      const state = authFieldsState({
        own: { authMethod: 'agent' },
        beneath,
        parentId: 'db',
        groups,
        forgetSecret: false
      })

      expect(state.shownMethod).toBe('agent')
      expect(state.inheritedMethod).toBe('privateKey')
    })

    it('lets the override win where it states something', () => {
      const state = authFieldsState({
        own: { username: 'root' },
        beneath,
        parentId: 'db',
        groups,
        forgetSecret: false
      })

      expect(state.effective.username).toBe('root')
    })

    /**
     * The bug this module was written out of. A field cleared back to "from the
     * inventory" holds `undefined`, and layering it with a plain spread wrote
     * that over the repository's value — so the dialog showed the group's
     * setting while the connection, which layers with `applyOverride`, used the
     * repository's.
     */
    it('falls back to the repository when a field is cleared, not past it', () => {
      const state = authFieldsState({
        own: { username: undefined, authMethod: undefined },
        beneath,
        parentId: 'db',
        groups,
        forgetSecret: false
      })

      expect(state.effective.username).toBe('ansible')
      expect(state.effective.username).not.toBe('ops')
      expect(state.shownMethod).toBe('privateKey')
    })

    it('treats a blank string the same as cleared', () => {
      const state = authFieldsState({
        own: { username: '' },
        beneath,
        parentId: 'db',
        groups,
        forgetSecret: false
      })

      expect(state.effective.username).toBe('ansible')
    })
  })
})

describe('what to store for a credential', () => {
  it('saves what was typed', () => {
    expect(secretToSave('password', false, 'hunter2')).toBe('hunter2')
  })

  it('leaves an untouched field alone', () => {
    expect(secretToSave('password', false, '')).toBeUndefined()
  })

  it('forgets the one held when nothing was typed', () => {
    expect(secretToSave('password', true, '')).toBeNull()
  })

  /** Typing is the later answer, whatever was ticked before it. */
  it('prefers what was typed over a pending forget', () => {
    expect(secretToSave('password', true, 'hunter2')).toBe('hunter2')
  })

  it('stores nothing for agent authentication, whatever is in the box', () => {
    // Left over from switching away from password auth, and not a credential
    // agent authentication has any use for.
    expect(secretToSave('agent', false, 'hunter2')).toBeUndefined()
  })

  it('still forgets under agent authentication when that was asked for', () => {
    expect(secretToSave('agent', true, 'hunter2')).toBeNull()
  })
})
