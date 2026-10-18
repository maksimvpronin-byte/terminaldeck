import { describe, it, expect, vi } from 'vitest'
import type { SessionProfile } from '../../shared/types'

/**
 * A saved account can sign in with a key, and what the vault keeps for it is
 * then the key's passphrase. Chosen for a desktop, that passphrase went to the
 * far end as the Windows password, and the prompt for one was skipped.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp', isPackaged: false },
  clipboard: {},
  ipcMain: {
    on: () => undefined,
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))
const start = vi.fn(() => 'desktop1')
vi.mock('../rdp/FreeRdpBridge', () => ({ freeRdpBridge: { start } }))
vi.mock('./win', () => ({ focusedWin: () => ({}) }))
const desktop = {
  id: 'h1',
  name: 'win',
  host: 'win.example',
  protocol: 'rdp',
  groupId: null,
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 0,
  updatedAt: 0
}
vi.mock('../store/hosts', () => ({
  findProfile: (id: string) => (id === 'h1' ? desktop : undefined),
  everyGroup: () => []
}))
const keyAccount = {
  id: 'key',
  name: 'deploy key',
  username: 'deploy',
  authMethod: 'privateKey',
  privateKeyPath: '/k',
  secretRef: 'pp',
  createdAt: 0,
  updatedAt: 0
}
const passwordAccount = { ...keyAccount, id: 'pw', authMethod: 'password', secretRef: 'pwd' }
vi.mock('../store/CredentialStore', () => ({
  credentialStore: {
    list: () => [keyAccount, passwordAccount],
    find: (id: string) => [keyAccount, passwordAccount].find((c) => c.id === id)
  }
}))
vi.mock('../vault/Vault', () => ({
  vault: { getSecret: (ref: string) => ({ pp: 'SSH_ONLY', pwd: 'WIN_PASSWORD' })[ref] }
}))

const { registerRdpHandlers } = await import('./rdp')
const { IPC } = await import('../../shared/ipc-channels')
registerRdpHandlers()

describe('a saved account on a desktop', () => {
  it('sends no key passphrase as the password, and asks for one', () => {
    expect(handlers.get(IPC.rdpLogin)!({}, 'h1', 'key')).toEqual({
      username: 'deploy',
      hasPassword: false
    })
    handlers.get(IPC.desktopStart)!(
      {},
      { sessionId: 'h1', credentialId: 'key', width: 1, height: 1 }
    )
    expect(start).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ username: 'deploy', password: '' }),
      undefined
    )
  })

  it('still sends an account’s password', () => {
    expect(handlers.get(IPC.rdpLogin)!({}, 'h1', 'pw')).toEqual({
      username: 'deploy',
      hasPassword: true
    })
    handlers.get(IPC.desktopStart)!(
      {},
      { sessionId: 'h1', credentialId: 'pw', width: 1, height: 1 }
    )
    expect(start).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ password: 'WIN_PASSWORD' }),
      undefined
    )
  })
})

/*
 * A group that signs its SSH hosts in with a key keeps the key's passphrase.
 * A desktop in it with no RDP login of the group's inherits the group's
 * login, and the passphrase came with it as the Windows password.
 */
describe('a desktop in a group that signs in with a key', () => {
  it('takes the group’s login and not the key’s passphrase', async () => {
    const { resolveAuth } = await import('../../shared/authResolution')
    const groups = [
      {
        id: 'g',
        name: 'servers',
        parentId: null,
        username: 'deploy',
        authMethod: 'privateKey' as const,
        privateKeyPath: '/k',
        secretRef: 'pp'
      }
    ]
    const host = { ...desktop, groupId: 'g' } as unknown as SessionProfile
    const auth = resolveAuth(host, 'g', groups, { protocol: 'rdp' })
    expect(auth.username).toBe('deploy')
    expect(auth.secretRef).toBeUndefined()
  })
})
