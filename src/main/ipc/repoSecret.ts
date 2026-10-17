import { repoUrlHasSecret } from '../../shared/repoSecret'

/**
 * Refuses a repository address with a password or token in it — unless it is
 * the address already saved, so a folder or source that had one before this
 * rule can still be moved, renamed and synced. Its dialog asks for the
 * address to be cleaned the next time it is opened and saved.
 */
export function refuseRepoSecret(url: string, before: string | undefined): void {
  if (typeof url === 'string' && url !== before && repoUrlHasSecret(url)) {
    throw new Error(
      'Take the password or token out of the repository address: git gets it from its credential helper'
    )
  }
}
