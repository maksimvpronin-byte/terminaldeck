/**
 * OSC 7 — the escape sequence a shell prints to say where it is:
 *
 *     ESC ] 7 ; file://<host>/<path> BEL
 *     ESC ] 7 ; file://<host>/<path> ESC \
 *
 * Terminals use it to keep a file browser in step with `cd`. We scan the shell
 * output for it rather than asking the host anything, which costs nothing when
 * the feature is off and needs no second channel when it is on.
 */

const START = '\u001b]7;'

export interface Osc7Scan {
  /** The last complete path seen in this chunk, if any. */
  path?: string
  /**
   * What to carry into the next chunk. A sequence can be split across reads,
   * so an unterminated start is kept rather than thrown away — but only that,
   * so a chatty command cannot grow the buffer without bound.
   */
  rest: string
}

/** Percent-decoding, since a path with a space arrives as %20. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A stray % that is not an escape would throw; the raw text is better
    // than nothing, and better than losing the whole update.
    return value
  }
}

/**
 * Pulls the path out of `file://host/path`. The host part is ignored: it is
 * whatever the remote shell believes its own name to be, which is of no use to
 * us — we already know which connection this arrived on.
 */
function pathFromUrl(url: string): string | undefined {
  if (!url.startsWith('file://')) return undefined
  const afterScheme = url.slice('file://'.length)
  const slash = afterScheme.indexOf('/')
  if (slash < 0) return undefined
  const path = decode(afterScheme.slice(slash))
  return path.trim() === '' ? undefined : path
}

export function scanOsc7(chunk: string): Osc7Scan {
  let path: string | undefined
  let cursor = 0

  for (;;) {
    const start = chunk.indexOf(START, cursor)
    if (start < 0) break

    const body = start + START.length
    const bel = chunk.indexOf('\u0007', body)
    const st = chunk.indexOf('\u001b\\', body)
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st)

    if (end < 0) {
      // Started but not finished — keep it for the next chunk.
      return { path, rest: chunk.slice(start) }
    }
    const found = pathFromUrl(chunk.slice(body, end))
    if (found) path = found
    cursor = end + (end === st ? 2 : 1)
  }

  // Nothing pending: keep only a suffix that could be the beginning of a start
  // marker split across two reads — at most three bytes, never the whole chunk.
  for (let keep = Math.min(START.length - 1, chunk.length); keep > 0; keep--) {
    const tail = chunk.slice(chunk.length - keep)
    if (START.startsWith(tail)) return { path, rest: tail }
  }
  return { path, rest: '' }
}

/**
 * The one-liner that makes a shell emit OSC 7 when it has not been set up to.
 *
 * Sent as a single line so the echo on connect is one line rather than a screen
 * of function definitions. It prepends rather than replaces `PROMPT_COMMAND`,
 * so an existing prompt setup keeps working.
 */
export const OSC7_SHELL_SETUP =
  `__td7(){ printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-}" "$PWD"; }; ` +
  `if [ -n "$ZSH_VERSION" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __td7; ` +
  `elif [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND="__td7\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"; fi; __td7`
