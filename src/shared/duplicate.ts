import type { SessionProfile } from './types'

/**
 * A copy of a host that shares nothing with it but its settings.
 *
 * Every vault reference is dropped, so the copy has to be given credentials of
 * its own. It used to drop only the login's: the gateway password's reference
 * went with the copy, deleting the copy deleted the original's gateway
 * password, and typing a new one into the copy changed the original's.
 */
export function duplicateProfile(
  profile: SessionProfile,
  id: string,
  name: string,
  now: number
): SessionProfile {
  return {
    ...profile,
    id,
    name,
    secretRef: undefined,
    gatewaySecretRef: undefined,
    createdAt: now,
    updatedAt: now
  }
}
