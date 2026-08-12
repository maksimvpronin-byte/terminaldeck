/**
 * The sessions logged on to a Windows host, as `qwinsta` reports them.
 *
 * Parsed positionally rather than by column heading, because that output is
 * translated: an English host says `SESSIONNAME USERNAME ID STATE`, a Russian
 * one says `СЕАНС ПОЛЬЗОВАТЕЛЬ ID СОСТОЯНИЕ`, and matching on the words would
 * work on exactly one machine. What does not move is the shape — every row
 * carries exactly one bare integer, and that is the session id.
 */

export interface WinSession {
  /** Session id, which is what `mstsc /shadow:` takes. */
  id: number
  /** The logged-on user, or empty for a session nobody is using. */
  user: string
  /** `console`, `rdp-tcp#3`, `services`; the transport, not a person. */
  name: string
  /** Whatever the host called it — `Active`, `Активно`, `Disc`. Shown as sent. */
  state: string
  /** Whether the host marked this as the session the query came from. */
  current: boolean
}

/** Sessions worth offering: a real user is logged on and it is not a listener. */
export function shadowable(sessions: WinSession[]): WinSession[] {
  return sessions.filter((s) => s.user !== '' && s.id > 0 && !/^listen/i.test(s.state))
}

/**
 * Reads a `qwinsta` table.
 *
 * Rows look like these, with the current session marked by a leading `>`:
 *
 * ```text
 *  SESSIONNAME       USERNAME          ID  STATE   TYPE        DEVICE
 *  services                             0  Disc
 * >console           Administrator      1  Active
 *  rdp-tcp#3         maksim             3  Active
 *  rdp-tcp                          65536  Listen
 * ```
 */
export function parseSessions(output: string): WinSession[] {
  const sessions: WinSession[] = []

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line.trim()) continue

    const current = line.trimStart().startsWith('>')
    const body = line.replace(/^\s*>/, ' ')
    const tokens = body.trim().split(/\s+/)
    if (tokens.length < 2) continue

    // The id is the only bare integer on the row. The heading line has none,
    // so it drops out here without being recognised as a heading at all.
    const idAt = tokens.findIndex((t) => /^\d+$/.test(t))
    if (idAt < 1) continue
    const id = Number(tokens[idAt])
    if (!Number.isSafeInteger(id)) continue

    // Before the id: the session name, then a username if anyone is logged on.
    // A session with no user leaves that column blank, so one token means the
    // name alone — never a username with no session name.
    const before = tokens.slice(0, idAt)
    const name = before[0] ?? ''
    const user = before.length > 1 ? before.slice(1).join(' ') : ''

    sessions.push({
      id,
      user,
      name,
      state: tokens[idAt + 1] ?? '',
      current
    })
  }

  return sessions
}

/**
 * The command line for shadowing one session.
 *
 * `/control` asks for the keyboard and mouse as well as the picture; without it
 * the session can only be watched. `/noconsentprompt` skips asking the person
 * at the far end, and is honoured only where policy already allows it — where
 * it does not, the connection is refused rather than silently downgraded.
 */
export function shadowArgs(
  host: string,
  sessionId: number,
  options: { control: boolean; skipPrompt: boolean }
): string[] {
  const args = [`/shadow:${sessionId}`, `/v:${host}`]
  if (options.control) args.push('/control')
  if (options.skipPrompt) args.push('/noconsentprompt')
  return args
}
