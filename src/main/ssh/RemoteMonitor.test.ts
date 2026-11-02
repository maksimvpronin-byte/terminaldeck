import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const state = vi.hoisted(() => ({ unlocked: true }))
vi.mock('../vault/locked', () => ({
  requireUnlocked: () => {
    if (!state.unlocked) throw new Error('Vault locked')
  }
}))
vi.mock('./SSHManager', () => ({ sshManager: { exec: vi.fn(async () => '') } }))
const { remoteMonitor } = await import('./RemoteMonitor')
const { sshManager } = await import('./SSHManager')
const win = { isDestroyed: () => true } as BrowserWindow

afterEach(() => {
  state.unlocked = true
  remoteMonitor.stopAll()
  vi.clearAllMocks()
})

describe('starting monitoring while locked', () => {
  it('refuses without executing a remote command', () => {
    state.unlocked = false
    expect(() => remoteMonitor.start(win, 'conn')).toThrow('Vault locked')
    expect(sshManager.exec).not.toHaveBeenCalled()
  })
  it('can start after unlocking', () => {
    remoteMonitor.start(win, 'conn')
    expect(sshManager.exec).toHaveBeenCalledOnce()
  })
})
