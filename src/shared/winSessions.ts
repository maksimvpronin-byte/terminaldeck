/**
 * The sessions on a Windows host, as the Terminal Services API reports them.
 *
 * Read through `WTSEnumerateSessions` rather than out of `qwinsta`. That tool
 * answers in the host's own language and writes in its console code page, so its
 * table arrived through remoting as mojibake — unreadable by a person and
 * unparseable by a script. Worse, the state it names is translated too, which
 * left no way to tell an active session from a disconnected one, and
 * disconnected sessions were offered as shadow targets they can never be.
 *
 * The API answers with a number for the state and Unicode for the rest. Neither
 * the host's language nor its code page can change that.
 */

/** `WTS_CONNECTSTATE_CLASS`, in the order the API numbers it. */
const STATES = [
  'Active',
  'Connected',
  'ConnectQuery',
  'Shadow',
  'Disconnected',
  'Idle',
  'Listen',
  'Reset',
  'Down',
  'Init'
] as const

export interface WinSession {
  /** Session id, which is what `mstsc /shadow:` takes. */
  id: number
  /** The logged-on user, or empty for a session nobody is using. */
  user: string
  /** `Console`, `RDP-Tcp#3`, `Services`; the transport, not a person. */
  name: string
  /** The API's own state, so always this spelling whatever the host's language. */
  state: string
}

/**
 * Sessions worth offering.
 *
 * Only a session somebody is signed in to and using can be shadowed. Asking for
 * one that is merely disconnected gets an invitation to a listener with nothing
 * behind it: the connection completes, and is then dropped without a word.
 */
export function shadowable(sessions: WinSession[]): WinSession[] {
  return sessions.filter((s) => s.state === 'Active' && s.user !== '')
}

/**
 * Reads the rows the enumerator writes: id, station, state and user, separated
 * by tabs.
 *
 * ```text
 * 0	Services	4
 * 1	Console	0	Администратор
 * 3	RDP-Tcp#1	0	adminrdp
 * 65537	RDP-Tcp	6
 * ```
 *
 * A row whose state is not a number the API defines is dropped rather than
 * guessed at: anything else on this stream is an error message, and one parsed
 * as a session turns a refusal into a machine nobody is using.
 */
export function parseSessions(output: string): WinSession[] {
  const sessions: WinSession[] = []

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue
    const fields = line.split('\t')
    if (fields.length < 3) continue

    const id = Number(fields[0])
    const state = Number(fields[2])
    if (!Number.isSafeInteger(id) || id < 0) continue
    if (!Number.isInteger(state) || state < 0 || state >= STATES.length) continue

    sessions.push({
      id,
      name: fields[1].trim(),
      state: STATES[state],
      user: (fields[3] ?? '').trim()
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
