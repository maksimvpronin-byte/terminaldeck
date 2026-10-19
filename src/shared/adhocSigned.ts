/**
 * The file the ad-hoc signing hook leaves inside a macOS bundle it had to sign
 * with nothing in particular, and the reason the updater has to know.
 *
 * Squirrel.Mac replaces the running application only when the new bundle's
 * signature satisfies the old one's designated requirement. Two ad-hoc
 * signatures share no identity — each is only its own hash — so the check can
 * never pass, whatever the two versions are. The download succeeds, the install
 * cannot, and the app has spent a hundred megabytes to say so.
 *
 * Written before `codesign` runs, so the signature covers it: a file added to
 * Contents/Resources afterwards breaks the very seal it is reporting.
 */
export const ADHOC_MARKER = 'adhoc-signed'

/**
 * Whether a build can install an update over itself.
 *
 * Two cannot. An ad-hoc signed Mac build, for the reason above. And the
 * portable Windows build: what the updater downloads and runs is the NSIS
 * installer, which installs a copy of its own elsewhere and leaves the
 * portable file as it was — started again, it was the old version, offering
 * the same update. Otherwise an unsigned update installs perfectly well on
 * Windows and Linux; SmartScreen complains about the installer, which is a
 * different conversation and not this one.
 */
export function canReplaceItself(
  platform: string,
  adhocSigned: boolean,
  portable = false
): boolean {
  if (portable) return false
  return platform !== 'darwin' || !adhocSigned
}
