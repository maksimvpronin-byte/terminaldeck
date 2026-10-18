import { describe, it, expect, vi } from 'vitest'

/**
 * Closing a session sends an edited file first, which can take seconds. The
 * tunnels waited with it, still bound: a reconnect in the meantime found its
 * ports taken, and when the old ones closed the new tunnels never started.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
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
vi.mock('../ssh/PortForwardManager', () => ({
  portForwardManager: { stopAllForConnection: stopForwards }
}))
vi.mock('../ssh/RemoteEdit', () => ({
  remoteEdit: {
    flush: () => new Promise<void>((resolve) => (finishFlush = resolve)),
    stopAllFor: vi.fn()
  }
}))
vi.mock('../ssh/RemoteMonitor', () => ({ remoteMonitor: { stop: vi.fn() } }))
vi.mock('../ssh/SFTPManager', () => ({ sftpManager: { releaseConnection: vi.fn() } }))
vi.mock('../ssh/SSHManager', () => ({ sshManager: { disconnect, onClosed: vi.fn() } }))
vi.mock('../ssh/sshConfig', () => ({ readSshConfigHosts: vi.fn() }))
vi.mock('../store/CredentialStore', () => ({ credentialStore: {} }))
vi.mock('../store/hosts', () => ({ findProfile: vi.fn() }))

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
