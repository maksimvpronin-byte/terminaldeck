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
 * Names an account on the host rather than on the machine asking.
 *
 * Windows reads a bare `administrator` as a *local* account of the computer
 * running the command, so a standalone server answers 1326 — the same code as a
 * wrong password, which is what makes this worth doing rather than diagnosing.
 * A name that already carries a domain or is a UPN is left alone.
 */
export function qualifyUser(username: string, host: string): string {
  const name = username.trim()
  if (!name || name.includes('\\') || name.includes('@')) return name
  return `${host}\\${name}`
}

/**
 * The Windows error number in a command's output, if it named one.
 *
 * Read from the digits rather than the words. These tools answer in the console
 * codepage and in the machine's own language — `System error 1326 has occurred`
 * on one host, `Системная ошибка 1326` on another — so the number is the only
 * part that can be relied on.
 */
export function errorCode(output: string): number | null {
  // No `\b` before the word: JavaScript's word boundary is ASCII-only, so there
  // is no boundary at all between a space and a Cyrillic letter, and the
  // Russian form would never match.
  const named = output.match(/(?:error|ошибка)\D{0,12}?(\d{1,5})/i)
  if (named) return Number(named[1])

  // `Ошибка [5]:Отказано в доступе` — one digit, and the commonest of all.
  const bracketed = output.match(/\[(\d{1,5})\]/)
  if (bracketed) return Number(bracketed[1])

  // Last resort, and the one that carries the load in practice: this output is
  // read in the console codepage, so the word around the number is mojibake
  // and only the digits survive.
  //
  // One digit counts. `Access denied` is error 5, and requiring three left the
  // commonest failure of all looking like a clean empty answer. Safe only
  // because this is asked about output from a command that failed — never
  // about a session table, where the numbers are ids.
  const bare = output.match(/(?:^|\D)(\d{1,5})(?:\D|$)/)
  return bare ? Number(bare[1]) : null
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
