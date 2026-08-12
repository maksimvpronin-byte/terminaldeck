import { execFile } from 'child_process'
import { parseSessions, shadowArgs, type WinSession } from '../../shared/winSessions'

/**
 * Listing and shadowing the sessions on a Windows host.
 *
 * Both lean on tools that ship with Windows, because the protocol underneath
 * shadowing is not RDP on 3389: it goes through RPC and SMB, and no client this
 * app could embed speaks it. `mstsc` therefore opens a window of its own, which
 * is the compromise this feature is — worth it because the alternative is not
 * having it at all.
 */

/** Long enough for a slow domain lookup, short enough not to wedge a pane. */
const QUERY_TIMEOUT_MS = 8000

export interface SessionQuery {
  sessions: WinSession[]
  /** Why the list is empty, when it is empty for a reason worth showing. */
  problem?: string
}

/**
 * Asks a host who is logged on to it.
 *
 * Never rejects: an unreachable host, a refused query and a machine with nobody
 * on it are all ordinary answers here, and a pane that opened to a thrown error
 * because the *optional* half of the dialog failed would be a poor trade.
 */
export async function listSessions(host: string): Promise<SessionQuery> {
  if (process.platform !== 'win32') {
    return { sessions: [], problem: 'Shadowing needs the Windows client, which only Windows has' }
  }

  return new Promise<SessionQuery>((resolve) => {
    execFile(
      'qwinsta',
      [`/server:${host}`],
      { timeout: QUERY_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        const text = `${stdout}${stderr}`
        const sessions = parseSessions(text)
        if (sessions.length > 0) {
          resolve({ sessions })
          return
        }
        resolve({ sessions: [], problem: explain(err, text) })
      }
    )
  })
}

/**
 * Turns a failed query into something worth reading.
 *
 * The two answers that actually happen are "no rights on that machine" and
 * "the firewall is not open for this", and neither is guessable from
 * `Error [5]`.
 */
function explain(err: Error | null, output: string): string | undefined {
  const text = output.trim()
  if (/denied|отказано/i.test(text)) {
    return 'Access denied — shadowing needs administrator rights on that host'
  }
  if (/\[1722\]|RPC server is unavailable|RPC-сервер недоступен/i.test(text)) {
    return 'The host did not answer the query — file and printer sharing must be open on it, not only Remote Desktop'
  }
  if (err && 'killed' in err && (err as { killed?: boolean }).killed) {
    return 'The host did not answer in time'
  }
  if (text) return text.split(/\r?\n/)[0]
  // A clean run that listed nobody: the machine simply has no one on it.
  return undefined
}

/**
 * Opens the Windows client on an existing session.
 *
 * Detached on purpose: this window belongs to the user, not to this app, and it
 * must outlive the pane that started it.
 */
export function shadowSession(
  host: string,
  sessionId: number,
  options: { control: boolean; skipPrompt: boolean }
): void {
  if (process.platform !== 'win32') throw new Error('Shadowing is only possible from Windows')

  const child = execFile('mstsc', shadowArgs(host, sessionId, options), { windowsHide: false })
  child.unref()
}
