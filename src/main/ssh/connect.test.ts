import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { BrowserWindow } from 'electron'
import type { SessionProfile } from '../../shared/types'

/**
 * Connecting, as far as it can be followed without a host: what is left open
 * when a connect does not finish.
 *
 * A client here is an emitter that signs in on the next turn, or never, as the
 * test says. That is enough to see the one thing that matters — whether every
 * client opened on the way to a host is closed again when the way is abandoned.
 */

const clients: FakeClient[] = []

class FakeClient extends EventEmitter {
  ended = false
  /** Whether connecting signs in, or waits for somebody to end it. */
  static signsIn = true
  constructor() {
    super()
    clients.push(this)
  }
  connect(): void {
    if (FakeClient.signsIn) setImmediate(() => this.emit('ready'))
  }
  end(): void {
    if (this.ended) return
    this.ended = true
    setImmediate(() => this.emit('close'))
  }
  forwardOut(
    _a: string,
    _b: number,
    _c: string,
    _d: number,
    cb: (err: Error | undefined, stream: unknown) => void
  ): void {
    setImmediate(() => cb(undefined, new EventEmitter()))
  }
  shell(_opts: unknown, cb: (err: Error | undefined, stream: unknown) => void): void {
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close() {} })
    setImmediate(() => cb(undefined, stream))
  }
}

vi.mock('ssh2', () => ({ Client: FakeClient }))
vi.mock('electron', () => ({
  app: { getPath: (): string => '' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: () => undefined, removeListener: () => undefined }
}))

const requestAuth = vi.fn()
vi.mock('./authPrompt', () => ({ requestAuth: (...args: unknown[]) => requestAuth(...args) }))
vi.mock('./hostVerifier', () => ({ makeHostVerifier: () => () => undefined }))
vi.mock('../vault/locked', () => ({ requireUnlocked: () => undefined }))
vi.mock('../vault/Vault', () => ({ vault: { getSecret: () => undefined } }))
vi.mock('../inventory/InventoryStore', () => ({ inventoryStore: { allGroups: () => [] } }))
vi.mock('../gitFolders/GitFolderStore', () => ({ gitFolderStore: { allGroups: () => [] } }))

function host(id: string, extra: Partial<SessionProfile> = {}): SessionProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    groupId: null,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0,
    username: 'me',
    authMethod: 'password',
    ...extra
  }
}

const bastion = host('bastion')
const target = host('target', { jumpHostId: 'bastion' })
vi.mock('../store/SessionStore', () => ({
  sessionStore: { getAll: () => ({ sessions: [bastion, target], groups: [] }) }
}))

const { sshManager, ConnectCancelledError } = await import('./SSHManager')

const win = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as BrowserWindow

beforeEach(() => {
  clients.length = 0
  FakeClient.signsIn = true
  requestAuth.mockReset()
})

describe('a connect that does not finish', () => {
  it('closes the jump host when the password for the destination is cancelled', async () => {
    // The bastion is answered; the destination's prompt is cancelled.
    requestAuth.mockResolvedValueOnce(['bastion password']).mockResolvedValueOnce(null)

    await expect(sshManager.connectProfile(win, target, 80, 24)).rejects.toThrow(/cancelled/i)

    expect(clients).toHaveLength(2)
    expect(clients.every((c) => c.ended)).toBe(true)
  })

  it('closes everything and withdraws the prompt when the pane gives up on it', async () => {
    requestAuth.mockResolvedValueOnce(['bastion password'])
    // The destination's question is still on screen when the pane closes.
    let signal: AbortSignal | undefined
    requestAuth.mockImplementationOnce(
      (_win: unknown, _options: unknown, opts: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          signal = opts.signal
          opts.signal?.addEventListener('abort', () => resolve(null))
        })
    )

    const connecting = sshManager.connectProfile(win, target, 80, 24, undefined, 'attempt-1')
    await vi.waitFor(() => expect(signal).toBeDefined())
    sshManager.cancelConnect('attempt-1')

    await expect(connecting).rejects.toBeInstanceOf(ConnectCancelledError)
    expect(signal?.aborted).toBe(true)
    expect(clients.every((c) => c.ended)).toBe(true)
  })

  it('gives up on a handshake that is still in progress', async () => {
    requestAuth.mockResolvedValue(['a password'])
    FakeClient.signsIn = false

    const connecting = sshManager.connectProfile(win, bastion, 80, 24, undefined, 'attempt-2')
    await vi.waitFor(() => expect(clients).toHaveLength(1))
    sshManager.cancelConnect('attempt-2')

    await expect(connecting).rejects.toBeInstanceOf(ConnectCancelledError)
    expect(clients[0].ended).toBe(true)
  })
})
