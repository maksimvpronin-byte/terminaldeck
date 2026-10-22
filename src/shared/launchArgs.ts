/**
 * The hosts a command line asks to have opened: `TerminalDeck.exe -s web-01`.
 *
 * `-s name` and `--session name`, each as many times as wanted, and the
 * `--session=name` form too. Everything else on the line is left alone: it is
 * also where Electron and Chromium put switches of their own, and where a
 * development build has `.` for the app's folder.
 */
export function hostsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const joined = arg.match(/^(?:-s|--session)=(.*)$/)
    let value: string | undefined
    if (joined) value = joined[1]
    else if (arg === '-s' || arg === '--session') {
      // A switch where the name should be is a mistyped line, not a host, and
      // is still read as the switch it is.
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        value = next
        i++
      }
    }
    const name = hostName(value)
    if (name) out.push(name)
  }
  return out
}

/** A name as `-s` takes it: trimmed, and never a switch. */
function hostName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.trim()
  return name && !name.startsWith('-') ? name : undefined
}

/** What a second launch hands the copy already running, alongside its lock. */
export interface LaunchData {
  hosts: string[]
}

/**
 * The hosts a second launch asked for, from what it handed over — see
 * index.ts for why they travel this way and not in its argv.
 *
 * It comes from another process, so it is checked before it is believed: a
 * list of names, each as `-s` would have taken it, and nothing else.
 */
export function hostsFromLaunchData(data: unknown): string[] {
  if (typeof data !== 'object' || data === null) return []
  const hosts = (data as Partial<Record<keyof LaunchData, unknown>>).hosts
  if (!Array.isArray(hosts)) return []
  return hosts.map(hostName).filter((name): name is string => name !== undefined)
}
