import { beforeAll, afterAll, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const state = vi.hoisted(() => ({
  dir: '',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sender: { id: 1 }
}))
vi.mock('electron', () => ({
  app: { getPath: () => state.dir },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler)
  }
}))
vi.mock('../ssh/SSHManager', () => ({
  sshManager: {
    diagnosticTarget: (id: string) =>
      id === 'connection' ? { host: 'real-target.example', sender: state.sender } : undefined,
    onDiagnosticDisconnect: () => () => {},
    getClientChain: () => []
  }
}))
import { vault } from '../vault/Vault'
import { aiSettings, saveAiSettings, clearAiSettings, stopAi } from './service'
import { registerAiHandlers } from '../ipc/ai'
import { IPC } from '../../shared/ipc-channels'
beforeAll(async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'td-ai-secret-'))
  await vault.create('fixture-vault-password')
  registerAiHandlers()
})
afterAll(() => {
  stopAi()
  vault.lock()
  rmSync(state.dir, { recursive: true, force: true })
})
it('only returns key presence and persists provider credentials encrypted', () => {
  const value = saveAiSettings({
    endpoint: 'https://example.org/v1',
    model: 'test',
    apiKey: 'private-provider-key',
    consent: true
  })
  expect(value.keyPresent).toBe(true)
  expect(JSON.stringify(value)).not.toContain('private-provider-key')
  for (const name of readdirSync(state.dir))
    expect(readFileSync(join(state.dir, name), 'utf8')).not.toContain('private-provider-key')
  expect(aiSettings()).toEqual(value)
})
it('binds proposals to the actual SSH host and rejects another renderer', () => {
  const start = state.handlers.get(IPC.aiStart)!
  expect(() => start({ sender: { id: 2 } }, 'connection', 'en')).toThrow('belong')
  const analysis = start({ sender: state.sender }, 'connection', 'en') as {
    host: string
    status: string
  }
  expect(analysis.host).toBe('real-target.example')
  expect(analysis.status).toBe('awaiting')
})
it('removes the key and refuses settings or new actions when locked', () => {
  expect(clearAiSettings().keyPresent).toBe(false)
  vault.lock()
  expect(() => aiSettings()).toThrow(/locked/i)
  expect(() =>
    state.handlers.get(IPC.aiStart)!({ sender: state.sender }, 'connection', 'en')
  ).toThrow(/locked/i)
})
