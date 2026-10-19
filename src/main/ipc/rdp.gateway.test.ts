import { describe, it, expect, vi } from 'vitest'

/**
 * An RD Gateway with a password of its own and no login of its own.
 *
 * The dialog offers exactly that — the login box says "the host's own login"
 * when it is left blank — and the password typed beside it was thrown away:
 * the client was told to sign in to the gateway with the desktop's password,
 * and a gateway that wants another one refused it.
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
const base = {
  name: 'win',
  host: 'win.example',
  protocol: 'rdp',
  groupId: null,
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 0,
  updatedAt: 0,
  username: 'CORP\\admin',
  secretRef: 'desk',
  gatewayHost: 'gw.example'
}
const hosts: Record<string, object> = {
  ownPassword: { ...base, id: 'ownPassword', gatewaySecretRef: 'gw' },
  same: { ...base, id: 'same' },
  ownLogin: { ...base, id: 'ownLogin', gatewayUsername: 'gwuser', gatewaySecretRef: 'gw' }
}
vi.mock('../store/hosts', () => ({
  findProfile: (id: string) => hosts[id],
  everyGroup: () => []
}))
vi.mock('../store/CredentialStore', () => ({
  credentialStore: { list: () => [], find: () => undefined }
}))
vi.mock('../vault/Vault', () => ({
  vault: { getSecret: (ref: string) => ({ desk: 'DESKTOP', gw: 'GATEWAY' })[ref] }
}))

const { registerRdpHandlers } = await import('./rdp')
const { IPC } = await import('../../shared/ipc-channels')
registerRdpHandlers()

function gatewayFor(id: string): unknown {
  handlers.get(IPC.desktopStart)!({}, { sessionId: id, width: 1, height: 1 })
  return (start.mock.lastCall as unknown[])[3]
}

describe('an RD Gateway', () => {
  it('signs in with its own password under the host’s login', () => {
    expect(gatewayFor('ownPassword')).toMatchObject({
      username: 'admin',
      domain: 'CORP',
      password: 'GATEWAY'
    })
  })

  it('takes the desktop’s login whole when it has none of its own', () => {
    expect(gatewayFor('same')).toMatchObject({ username: undefined, password: undefined })
  })

  it('signs in with a login and password of its own', () => {
    expect(gatewayFor('ownLogin')).toMatchObject({ username: 'gwuser', password: 'GATEWAY' })
  })
})
