import { describe, it, expect, vi } from 'vitest'

/**
 * Closing a session sends an edited file first, which can take seconds. The
 * tunnels waited with it, still bound: a reconnect in the meantime found its
 * ports taken, and when the old ones closed the new tunnels never started.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => null,
    getAllWindows: () => [{}],
    getFocusedWindow: () => ({})
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    },
    on: (): void => undefined
  }
}))

let finishFlush: () => void = () => undefined
const stopForwards = vi.fn()
const disconnect = vi.fn()
const startForward = vi.fn()
vi.mock('../ssh/PortForwardManager', () => ({
  portForwardManager: { stopAllForConnection: stopForwards, start: startForward }
}))
vi.mock('../ssh/RemoteEdit', () => ({
  remoteEdit: {
    flush: () => new Promise<void>((resolve) => (finishFlush = resolve)),
    stopAllFor: vi.fn()
  }
}))
vi.mock('../ssh/RemoteMonitor', () => ({ remoteMonitor: { stop: vi.fn() } }))
vi.mock('../ssh/SFTPManager', () => ({ sftpManager: { releaseConnection: vi.fn() } }))
const connectProfile = vi.fn()
vi.mock('../ssh/SSHManager', () => ({
  sshManager: { disconnect, onClosed: vi.fn(), connectProfile, reportError: vi.fn() }
}))
vi.mock('../ssh/sshConfig', () => ({ readSshConfigHosts: vi.fn() }))
vi.mock('../store/CredentialStore', () => ({ credentialStore: {} }))
const findProfile = vi.fn()
vi.mock('../store/hosts', () => ({ findProfile }))

const { registerSshHandlers } = await import('./ssh')
const { IPC } = await import('../../shared/ipc-channels')
registerSshHandlers()

describe('closing a session with an edit still on its way', () => {
  it('lets its tunnels go before it waits for the edit', async () => {
    const closing = handlers.get(IPC.sshDisconnect)!({}, 'c1') as Promise<void>
    await Promise.resolve()

    expect(stopForwards).toHaveBeenCalledWith('c1')
    expect(disconnect).not.toHaveBeenCalled()

    finishFlush()
    await closing
    expect(disconnect).toHaveBeenCalledWith('c1')
  })
})

/*
 * A remote forward the server never answers held the connection back from
 * the pane, which stayed connecting for ever: tunnels come up beside the
 * shell, not in front of it.
 */
describe('connecting a host with tunnels', () => {
  it('hands the pane its connection without waiting for the tunnels', async () => {
    findProfile.mockReturnValue({ id: 's1', portForwards: [{ id: 'r1', type: 'remote' }] })
    connectProfile.mockResolvedValue('c9')
    startForward.mockReturnValue(new Promise(() => undefined))

    await expect(handlers.get(IPC.sshConnect)!({}, 's1', 80, 24)).resolves.toEqual({
      connectionId: 'c9'
    })
    expect(startForward).toHaveBeenCalledWith('c9', { id: 'r1', type: 'remote' })
  })
})
