import { vault } from './Vault'

/**
 * The lock, as something the main process enforces rather than something the
 * window draws.
 *
 * Locking wiped the key and covered the interface with an overlay, and that was
 * the whole of it: every channel went on working underneath. The overlay stops
 * a mouse and, now, a keyboard — but a lock that exists only in the window is a
 * lock that one bug in the window undoes, and there was such a bug: two presses
 * of Tab reached the interface behind it.
 *
 * It also did not cover the case the vault cannot see at all. A host that signs
 * in with a key file or through the agent never asks the vault for anything, so
 * "locked" did not stop a new session being opened to it, a file being read
 * over SFTP, or a desktop being started. The vault being shut has to mean the
 * application is shut, and this is where that is said.
 *
 * Deliberately not applied to what is already running: an open terminal keeps
 * its connection, keeps receiving output and keeps its scrollback. Locking is
 * not disconnecting — that would drop work in progress every time somebody went
 * to lunch — it is refusing to start anything new and refusing to hand anything
 * out while nobody is there to say so.
 */
export class VaultLockedError extends Error {
  constructor() {
    super('The vault is locked. Unlock TerminalDeck to continue.')
    this.name = 'VaultLockedError'
  }
}

/** Throws unless the vault is open. */
export function requireUnlocked(): void {
  if (!vault.status().unlocked) throw new VaultLockedError()
}
