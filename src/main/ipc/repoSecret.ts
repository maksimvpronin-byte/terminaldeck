import { repoUrlHasSecret } from '../../shared/repoSecret'

/**
 * Refuses a repository address with a password or token in it. The dialogs say
 * so first; this is for whatever reaches the main process without them. One
 * saved before the rule is taken out at start; see scrubRepoSecrets.
 */
export function refuseRepoSecret(url: unknown): void {
  if (typeof url === 'string' && repoUrlHasSecret(url)) {
    throw new Error(
      'Take the password or token out of the repository address: git gets it from its credential helper'
    )
  }
}
