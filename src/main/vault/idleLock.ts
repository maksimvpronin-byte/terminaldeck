import { vault } from './Vault'

/**
 * The idle lock, for the time there is no page to keep it.
 *
 * The window counts idle minutes and locks the vault when they run out — but
 * only while it exists. On a Mac, closing the window leaves the application
 * running, and with it a vault that stayed open for as long as the application
 * did: the window opened again the next morning found it unlocked and asked
 * for nothing. So when the page goes, the count passes here, with the same
 * number of minutes, and comes back to the page when one loads.
 *
 * The page says how many minutes, because the setting is the page's; zero, as
 * there, means the person chose never to lock.
 */
export interface IdleLock {
  /** The `lockAfterMinutes` setting, as the page last said it. */
  setMinutes(minutes: number): void
  /** No page is counting any more: start the count here. */
  pageGone(): void
  /** A page is counting again. */
  pageBack(): void
}

export function createIdleLock(target: { isUnlocked(): boolean; lock(): void }): IdleLock {
  let minutes = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancel(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    setMinutes(value) {
      // The same bounds the settings dialog keeps; anything else is no lock.
      minutes = Number.isInteger(value) && value > 0 && value <= 480 ? value : 0
    },
    pageGone() {
      cancel()
      if (minutes <= 0 || !target.isUnlocked()) return
      timer = setTimeout(() => {
        timer = null
        target.lock()
      }, minutes * 60_000)
    },
    pageBack: cancel
  }
}

export const idleLock = createIdleLock(vault)
