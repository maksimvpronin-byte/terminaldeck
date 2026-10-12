import type { UpdateState } from './types'

/**
 * What a release being found means for an update already under way.
 *
 * electron-updater reports the newest release every time it is asked, whatever
 * was already done about it — and it is asked again by the hourly check and by
 * "Check for updates" in the settings. Answering "available" each time took a
 * download in progress back to its Download button, and an update already
 * downloaded back to one that had to be fetched again before it could install.
 *
 * A downloaded update stays ready to install even when a newer release is out:
 * the newer one is fetched behind it (see `overtaken`) and takes its place once
 * it is on disk, so the Install button never turns back into a Download one.
 */
export function stateForRelease(
  current: UpdateState,
  version: string,
  /** Whether this build can install an update over itself. */
  canInstall: boolean
): UpdateState {
  if (current.status === 'downloading' || current.status === 'ready') return current
  const status = canInstall ? 'available' : 'manual'
  // The same answer again is no news, and nothing is sent for it.
  if (current.status === status && current.version === version) return current
  return { status, version }
}

/**
 * Whether the update downloaded and waiting to install is no longer the newest.
 *
 * Releases can follow each other within the hour. An update downloaded and left
 * for a restart used to install the version it was downloaded as, and the first
 * thing the restarted app found was the release after it: a second update, and
 * a second restart, for what the person had already agreed to once. Having
 * agreed, they are not asked again: the newer release is fetched in the
 * background and replaces the one waiting.
 */
export function overtaken(current: UpdateState, version: string): boolean {
  return current.status === 'ready' && current.version !== version
}
