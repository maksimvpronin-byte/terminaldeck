import { registerAppHandlers } from './app'
import { registerInventoryHandlers } from './inventory'
import { registerRdpHandlers } from './rdp'
import { registerSftpHandlers } from './sftp'
import { registerSshHandlers } from './ssh'
import { registerStoreHandlers } from './store'
import { registerVaultHandlers } from './vault'

/**
 * Everything the renderer can ask the main process to do.
 *
 * One file per domain, each registering its own channels — the shape
 * `state/slices/` already uses on the other side of the boundary. It was one
 * file of seventy-five handlers, which is a fine way to write them and a poor
 * way to find one.
 *
 * The order below is the order they are registered in, which does not matter to
 * Electron; it reads outwards from the vault, since nothing else works until
 * that is open.
 */
export function registerIpcHandlers(): void {
  registerVaultHandlers()
  registerStoreHandlers()
  registerInventoryHandlers()
  registerSshHandlers()
  registerSftpHandlers()
  registerRdpHandlers()
  registerAppHandlers()
}
