import type { Credential, ResolvedAuth } from './types'

/**
 * A saved login put in place of the one a host resolved to.
 *
 * Applied to the *finished* resolution rather than layered onto the host as
 * another set of AuthDefaults, and that is the whole point of the function.
 * Layering would leave each field to the inheritance walk, so an account with
 * no password saved would quietly fall back to the host's — the connection
 * would then offer one account's name with another account's password, fail
 * with "permission denied", and give nothing to look at that says why.
 *
 * Replacing all four together cannot do that: the account's name, its method,
 * its key and its secret arrive as one thing. An absent `secretRef` therefore
 * means nothing is stored, the connection asks for it, and what is typed is
 * used for that session and not saved anywhere.
 *
 * Everything the credential says nothing about — port, jump host, agent
 * forwarding, the on-connect commands — is left exactly as the host resolved
 * it. An account is who you are on a machine, not where the machine is.
 */
export function applyCredential(
  auth: ResolvedAuth,
  credential: Credential | undefined
): ResolvedAuth {
  if (!credential) return auth
  return {
    ...auth,
    username: credential.username,
    authMethod: credential.authMethod,
    privateKeyPath: credential.privateKeyPath,
    secretRef: credential.secretRef
  }
}
