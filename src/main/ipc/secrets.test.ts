import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A host saved together with the passwords typed for it. The save is made to
 * fail after the vault has already been written, which is where the two used
 * to come apart: the host unchanged, its password changed or gone.
 */

let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))
userData = mkdtempSync(join(tmpdir(), 'terminaldeck-secrets-'))

const { vault } = await import('../vault/Vault')
const { saveWithSecrets } = await import('./secrets')

const MASTER = 'correct horse battery staple'
const failingSave = (): never => {
  throw new Error('ENOSPC: no space left on device')
}

beforeEach(async () => {
  vault.lock()
  rmSync(join(userData, 'vault.json'), { force: true })
  await vault.create(MASTER)
  vault.setSecret('host-ref', 'old password')
  vault.setSecret('gateway-ref', 'old gateway password')
})

describe('saving a host with its passwords', () => {
  it('stores them and the host together', () => {
    const host = { id: 'h', secretRef: undefined as string | undefined }
    const saved = saveWithSecrets(host, [['secretRef', 'new password']], (h) => h)

    expect(saved.secretRef).toBeDefined()
    expect(vault.getSecret(saved.secretRef!)).toBe('new password')
  })

  it('keeps the old password when the host fails to save', () => {
    const host = { id: 'h', secretRef: 'host-ref', gatewaySecretRef: 'gateway-ref' }

    expect(() =>
      saveWithSecrets(
        host,
        [
          ['secretRef', 'replacement'],
          ['gatewaySecretRef', 'gateway replacement']
        ],
        failingSave
      )
    ).toThrow(/ENOSPC/)

    expect(vault.getSecret('host-ref')).toBe('old password')
    expect(vault.getSecret('gateway-ref')).toBe('old gateway password')
  })

  it('does not forget a password when forgetting it fails to save', () => {
    const host = { id: 'h', secretRef: 'host-ref' }

    expect(() => saveWithSecrets(host, [['secretRef', null]], failingSave)).toThrow()

    expect(vault.getSecret('host-ref')).toBe('old password')
  })

  it('leaves the vault alone when nothing was typed', () => {
    const write = vi.spyOn(vault, 'changeSecrets')
    saveWithSecrets({ id: 'h', secretRef: 'host-ref' }, [['secretRef', undefined]], (h) => h)
    expect(write).not.toHaveBeenCalled()
  })
})
