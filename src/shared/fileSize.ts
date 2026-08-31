/**
 * Bytes as something a person reads at a glance.
 *
 * Powers of 1024 with the shorter names, which is what a file manager shows and
 * what `ls -lh` prints — not the decimal units the disk was sold in.
 *
 * Written out twice before this, identically, in the SFTP panel and the
 * transfer conflict dialog: the two places in the app that put a size in front
 * of someone, and the two that would have to be found and changed together.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let val = bytes / 1024
  let i = 0
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(1)} ${units[i]}`
}
