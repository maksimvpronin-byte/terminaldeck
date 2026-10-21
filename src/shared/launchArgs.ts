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
    const name = value?.trim()
    if (name && !name.startsWith('-')) out.push(name)
  }
  return out
}
