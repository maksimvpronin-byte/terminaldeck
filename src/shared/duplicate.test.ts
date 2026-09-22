import { describe, it, expect } from 'vitest'
import { duplicateProfile } from './duplicate'
import type { SessionProfile } from './types'

describe('duplicating a host', () => {
  it('takes none of the original’s passwords, the gateway’s included', () => {
    const original = {
      id: 'desk',
      name: 'Desk',
      host: 'desk.example',
      protocol: 'rdp',
      secretRef: 'login-ref',
      gatewaySecretRef: 'gateway-ref',
      gatewayHost: 'gw.example',
      createdAt: 1,
      updatedAt: 1
    } as unknown as SessionProfile

    const copy = duplicateProfile(original, 'copy', 'Desk copy', 5)

    expect(copy).toMatchObject({ id: 'copy', name: 'Desk copy', gatewayHost: 'gw.example' })
    expect(copy.secretRef).toBeUndefined()
    expect(copy.gatewaySecretRef).toBeUndefined()
    expect(original.gatewaySecretRef).toBe('gateway-ref')
  })
})
