import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/ipc-channels'
import type { AuthPromptField } from '../../shared/types'

/**
 * Asks the renderer for credentials mid-handshake — used for a password that
 * isn't in the vault and for keyboard-interactive challenges such as 2FA codes.
 * Resolves with null when the user cancels.
 */
export function requestAuth(
  win: BrowserWindow,
  options: { host: string; title: string; instructions?: string; fields: AuthPromptField[] }
): Promise<string[] | null> {
  if (win.isDestroyed()) return Promise.resolve(null)
  const requestId = randomUUID()

  return new Promise((resolve) => {
    const channel = `${IPC.authPromptReply}:${requestId}`
    const onReply = (_e: unknown, answers: string[] | null): void => {
      cleanup()
      resolve(answers)
    }
    const onClosed = (): void => {
      cleanup()
      resolve(null)
    }
    function cleanup(): void {
      ipcMain.removeListener(channel, onReply)
      win.removeListener('closed', onClosed)
    }

    ipcMain.once(channel, onReply)
    // Don't leave the handshake hanging if the window disappears.
    win.once('closed', onClosed)
    win.webContents.send(IPC.authPrompt, { requestId, ...options })
  })
}
