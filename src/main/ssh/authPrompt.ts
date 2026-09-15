import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../shared/ipc-channels'
import type { AuthPromptField } from '../../shared/types'

/**
 * How long a question waits for somebody to answer it.
 *
 * A prompt raised inside the handshake is already bounded by ssh2's own ready
 * timeout, but a password asked for before the handshake starts had nothing:
 * the connection sat there, holding whatever jump hosts it had already opened,
 * for as long as the dialog was left up — which, for someone who went home, was
 * until the application quit.
 */
export const AUTH_PROMPT_TIMEOUT_MS = 5 * 60_000

export interface AuthPromptOptions {
  /** Withdraws the question: the connection it was for has gone. */
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Asks the renderer for credentials mid-handshake — used for a password that
 * isn't in the vault and for keyboard-interactive challenges such as 2FA codes.
 * Resolves with null when the user cancels, when the question is withdrawn, or
 * when nobody answers in time. Whichever way it ends without an answer, the
 * renderer is told to take the dialog down, so a stale question is never left
 * on screen to be answered into nothing.
 */
export function requestAuth(
  win: BrowserWindow,
  options: { host: string; title: string; instructions?: string; fields: AuthPromptField[] },
  { signal, timeoutMs = AUTH_PROMPT_TIMEOUT_MS }: AuthPromptOptions = {}
): Promise<string[] | null> {
  if (win.isDestroyed() || signal?.aborted) return Promise.resolve(null)
  const requestId = randomUUID()

  return new Promise((resolve) => {
    const channel = `${IPC.authPromptReply}:${requestId}`
    let settled = false

    const finish = (answers: string[] | null, withdraw: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener(channel, onReply)
      win.removeListener('closed', onClosed)
      signal?.removeEventListener('abort', onAbort)
      if (withdraw && !win.isDestroyed()) win.webContents.send(IPC.authPromptCancel, requestId)
      resolve(answers)
    }

    const onReply = (event: IpcMainEvent, answers: unknown): void => {
      // Only the window that was asked may answer, and only with what was asked.
      if (!win.isDestroyed() && event.sender !== win.webContents) return
      finish(validAnswers(answers, options.fields.length), false)
    }
    const onClosed = (): void => finish(null, false)
    const onAbort = (): void => finish(null, true)
    const timer = setTimeout(() => finish(null, true), timeoutMs)
    timer.unref?.()

    ipcMain.on(channel, onReply)
    // Don't leave the handshake hanging if the window disappears.
    win.once('closed', onClosed)
    signal?.addEventListener('abort', onAbort, { once: true })
    win.webContents.send(IPC.authPrompt, { requestId, ...options })
  })
}

/** One string per field, or null — which is a cancel, not an empty password. */
function validAnswers(answers: unknown, count: number): string[] | null {
  if (!Array.isArray(answers) || answers.length !== count) return null
  return answers.every((a) => typeof a === 'string') ? (answers as string[]) : null
}
