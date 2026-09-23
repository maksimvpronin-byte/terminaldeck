import { describe, it, expect, vi } from 'vitest'

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

const { registerRdpHandlers } = await import('./rdp')
const { IPC } = await import('../../shared/ipc-channels')
registerRdpHandlers()

const desktopStart = (request: unknown): unknown => handlers.get(IPC.desktopStart)!({}, request)

/**
 * A desktop typed into Quick connect has no saved host behind it: where it is
 * and who to be come with the request, and everything else is a new host's
 * defaults — no gateway, nothing from the vault.
 */
describe('a desktop from Quick connect', () => {
  it('starts the client with what was typed, the domain split from the login', () => {
    const id = desktopStart({
      quick: { host: ' win.example ', port: 3390, username: 'CORP\\admin' },
      width: 1280,
      height: 800,
      password: 'typed'
    })

    expect(id).toBe('desktop1')
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ host: 'win.example', port: 3390, width: 1280, height: 800 }),
      { username: 'admin', domain: 'CORP', password: 'typed' }
    )
    // No gateway argument at all.
    expect((start.mock.calls[0] as unknown[]).length).toBe(3)
  })

  it('refuses a host that is not one', () => {
    expect(() =>
      desktopStart({ quick: { host: '-x', port: 3389, username: 'a' }, width: 1, height: 1 })
    ).toThrow(/host/)
  })
})
