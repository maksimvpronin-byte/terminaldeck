/* eslint-disable no-console -- Intercepting the console is what this module is for. */

/**
 * Catches the desktop client's log without letting it eat the window.
 *
 * The client logs through `console`, several lines per frame at `debug`. Left
 * to itself that is unusable as a diagnostic: the console holds every message
 * with its arguments, and a live desktop took the renderer to four gigabytes
 * and an out-of-memory crash inside forty seconds — twice, before anyone could
 * read what they had turned it on for.
 *
 * What is worth reading is agreed in the first seconds: the protocols, the
 * channels, the codecs. So the first `limit` lines are kept and the rest are
 * dropped — dropped rather than passed on, so nothing accumulates anywhere,
 * here or in the console. At the limit the original console is put back and the
 * lines are handed to whoever asked for them.
 */

/** One argument as text, without pulling a whole object graph into the line. */
function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // Circular, or something else that refuses to be stringified.
    return String(value)
  }
}

export interface ClientLogCapture {
  /** Everything caught so far, oldest first. */
  lines(): string[]
  /** Puts the console back, whether or not the limit was reached. */
  stop(): string[]
}

/**
 * Starts catching, and stops on its own at `limit`.
 *
 * `onFull` is called once, with everything caught, at the moment the limit is
 * reached — so a caller can write the file then rather than waiting for a
 * session that may run for hours. The console is already restored by the time
 * it runs, so a caller can report where the file went.
 */
export function captureClientLog(
  limit: number,
  onFull?: (lines: string[]) => void
): ClientLogCapture {
  const caught: string[] = []
  const original = {
    debug: console.debug,
    info: console.info,
    log: console.log,
    warn: console.warn,
    error: console.error
  }
  let stopped = false

  function stop(): string[] {
    if (!stopped) {
      stopped = true
      console.debug = original.debug
      console.info = original.info
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    }
    return caught
  }

  const catcher =
    (level: string) =>
    (...args: unknown[]): void => {
      if (caught.length >= limit) return
      caught.push(`[${level}] ${args.map(render).join(' ')}`)
      if (caught.length === limit) {
        stop()
        onFull?.(caught)
      }
      // Nothing is forwarded to the real console below the limit: forwarding is
      // what fills it, which is the whole problem being solved here.
    }

  console.debug = catcher('debug')
  console.info = catcher('info')
  console.log = catcher('log')
  console.warn = catcher('warn')
  console.error = catcher('error')

  return { lines: () => caught, stop }
}
