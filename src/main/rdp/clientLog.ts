/**
 * Reading what the desktop client says about itself.
 *
 * FreeRDP writes its own log to the client process's stderr — the shim points
 * descriptor 1 at 2 so a library writing to stdout cannot land in the middle of
 * a frame — and that log is the only place a failure is explained. What comes
 * back through the protocol is `freerdp_get_last_error_string`, which names the
 * step and nothing else: "the connection failed at negotiating security
 * settings" covers a host that refused every security level offered and a
 * connection that broke before the answer arrived, and those are two different
 * conversations with whoever is reading.
 *
 * Kept apart from the bridge so it can be tested: that one imports Electron.
 */

/** Long enough to carry a reason, short enough to stay one paragraph. */
const COMPLAINT_MAX = 200

/**
 * The complaint in one line of the client's log, or nothing.
 *
 * WinPR's default prefix is `[time] [pid:tid] [LEVEL][module] - [function]: `,
 * and only what follows it is worth reading in a pane. Levels below WARN are
 * the client narrating its own progress and say nothing about a failure.
 */
export function complaintIn(line: string): string | undefined {
  if (!/\[(WARN|ERROR|FATAL)\]/.test(line)) return undefined

  const text = line
    // Up to the first `] - `, which is where the prefix ends: the timestamp and
    // the process id are of no use to whoever is reading the pane.
    .replace(/^.*?\]\s*-\s*/, '')
    // And the function name the layout puts in front of the message itself.
    .replace(/^\[[^\]]*\]:\s*/, '')
    .trim()

  if (!text) return undefined
  return text.length > COMPLAINT_MAX ? `${text.slice(0, COMPLAINT_MAX)}…` : text
}

/**
 * Why a desktop did not open, in as many words as are known.
 *
 * The summary is FreeRDP's own sentence, the complaint is the client's last
 * word before it stopped, and the code is what makes a screenshot of the pane
 * worth as much as the log would have been. A complaint the summary already
 * contains is not said twice.
 */
export function failureText(summary: string, complaint?: string, code = 0): string {
  const said = summary.trim() || 'Could not connect'
  const both = complaint && !said.includes(complaint) ? `${said} — ${complaint}` : said
  return code ? `${both} (0x${code.toString(16).padStart(8, '0')})` : both
}
