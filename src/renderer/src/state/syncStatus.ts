import type { Translate } from '../i18n'

/**
 * How long ago something was last read from git, in words.
 *
 * Shared by the Inventory tab and the folders on the Sessions tab, which ask
 * the identical question about the identical field — and, since neither now
 * syncs on its own, ask it about something the user is meant to act on.
 */
export function ago(t: Translate, ts?: number): string {
  if (!ts) return t('never synced')
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return t('synced just now')
  if (mins < 60) return t('synced {count}m ago', { count: mins })
  const hours = Math.round(mins / 60)
  return hours < 24
    ? t('synced {count}h ago', { count: hours })
    : t('synced {count}d ago', { count: Math.round(hours / 24) })
}
