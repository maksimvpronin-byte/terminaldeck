import type { UpdateState } from './types'

/**
 * What a release being found means for an update already under way.
 *
 * electron-updater reports the newest release every time it is asked, whatever
 * was already done about it — and it is asked again by the hourly check and by
 * "Check for updates" in the settings. Answering "available" each time took a
 * download in progress back to its Download button, and an update already
 * downloaded back to one that had to be fetched again before it could install.
 */
export function stateForRelease(
  current: UpdateState,
  version: string,
  /** Whether this build can install an update over itself. */
  canInstall: boolean
): UpdateState {
  if (current.status === 'downloading') return current
  if (current.status === 'ready' && current.version === version) return current
  return canInstall ? { status: 'available', version } : { status: 'manual', version }
}
