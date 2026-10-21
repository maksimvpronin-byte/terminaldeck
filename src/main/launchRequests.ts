import { BrowserWindow, ipcMain } from 'electron'
import { promises as dns } from 'dns'
import { IPC } from '../shared/ipc-channels'
import { isIpAddress, type Resolved } from '../shared/hostMatch'
import { hostsFromArgv } from '../shared/launchArgs'
import { diag } from './diagnostics'

/**
 * Hosts asked for on the command line, held until the window takes them.
 *
 * `TerminalDeck.exe -s web-01` either starts the application, or — one copy at
 * a time, see index.ts — reaches the copy already running as its
 * `second-instance`. Either way the host cannot be opened yet: the vault may be
 * locked, the inventories may not be read. So the names wait here, the window
 * is told there are some, and it takes them when it can do something with them
 * — which may be after a master password. Nothing is opened from here, and
 * nothing but names travels: what a host is and how it is reached is what the
 * window already holds.
 */
const pending: string[] = []

/** Takes the hosts a command line names, and tells the window if it is there. */
export function requestFromArgv(argv: readonly string[]): void {
  const names = hostsFromArgv(argv)
  if (names.length === 0) return
  // Names only: they are hosts the user typed, not anything secret.
  diag('launch', `asked to open ${names.join(', ')}`)
  pending.push(...names)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.launchRequested)
  }
}

/** How long DNS gets before a host is said not to be found. */
const RESOLVE_MS = 3000

async function resolve(name: string): Promise<Resolved> {
  const lookup: Promise<Resolved> = isIpAddress(name)
    ? dns.reverse(name).then((names) => ({ addresses: [], names }))
    : dns
        .lookup(name, { all: true })
        .then((found) => ({ addresses: found.map((a) => a.address), names: [] }))
  const none: Resolved = { addresses: [], names: [] }
  const timeout = new Promise<Resolved>((done) => setTimeout(() => done(none), RESOLVE_MS))
  return Promise.race([lookup.catch(() => none), timeout])
}

export function registerLaunchHandlers(): void {
  ipcMain.handle(IPC.launchTake, () => pending.splice(0))
  ipcMain.handle(IPC.launchResolve, (_e, name: unknown) =>
    typeof name === 'string' && name.length <= 253 ? resolve(name) : { addresses: [], names: [] }
  )
}
