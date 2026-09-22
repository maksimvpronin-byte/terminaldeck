import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Removing an inventory repository, and the passwords that go with it. The
 * overrides kept for its hosts can hold a gateway password as well as a login,
 * and only the logins used to be forgotten.
 */

let userData = ''
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: (): string => userData },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, fn)
    }
  }
}))
userData = mkdtempSync(join(tmpdir(), 'terminaldeck-inventory-ipc-'))

const { vault } = await import('../vault/Vault')
const { inventoryStore } = await import('../inventory/InventoryStore')
const { registerInventoryHandlers } = await import('./inventory')
const { IPC } = await import('../../shared/ipc-channels')

registerInventoryHandlers()

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({}, ...args)
}

beforeEach(async () => {
  vault.lock()
  rmSync(join(userData, 'vault.json'), { force: true })
  await vault.create('correct horse battery staple')
})

describe('removing an inventory repository', () => {
  it('forgets the gateway passwords of its overrides as well as the logins', () => {
    vault.setSecrets({
      'source-login': 'a',
      'host-login': 'b',
      'host-gateway': 'c',
      'elsewhere-gateway': 'd'
    })
    inventoryStore.saveMany(
      [{ id: 'repo', name: 'Repo', repoUrl: 'x', paths: [], secretRef: 'source-login' }],
      [
        { nodeId: 'inv:repo:h:web1', secretRef: 'host-login', gatewaySecretRef: 'host-gateway' },
        { nodeId: 'inv:other:h:db1', gatewaySecretRef: 'elsewhere-gateway' }
      ]
    )

    invoke(IPC.inventoryRemoveSource, 'repo')

    expect(vault.getSecret('source-login')).toBeUndefined()
    expect(vault.getSecret('host-login')).toBeUndefined()
    expect(vault.getSecret('host-gateway')).toBeUndefined()
    // Another repository's is not this one's to take.
    expect(vault.getSecret('elsewhere-gateway')).toBe('d')
  })
})
