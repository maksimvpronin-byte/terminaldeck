/**
 * The commands a host runs on connecting, while they wait their turn.
 *
 * They were typed the moment the shell opened, and the setup line for
 * following the directory waited for a prompt. The two raced: `sudo -i`,
 * `cd /etc`, `mc` were already queued in the terminal when the setup line went
 * in, so it landed in whatever was running by then — root's shell, or `mc`,
 * which took it as keystrokes — and the user's own shell never got it. So the
 * commands wait for the setup line to be answered or given up on, and the
 * line goes to the shell the user logged in to.
 *
 * A command can hand the session to another shell, as `sudo -i` does, and that
 * shell knows nothing of the hook. So once the last command has been taken —
 * its echo seen — the prompt that follows is looked at once: a shell still
 * reporting its directory has printed OSC 7 by then, and one that has not is a
 * new shell, which is given the setup line in its turn.
 */

const OSC7_START = Buffer.from('\u001b]7;', 'latin1')

/** How much of the last command is looked for in its echo. */
const ECHO_CHARS = 32

/** What is kept of the output since the commands went in, to find the echo in. */
const SEEN_CHARS = 512

export class ConnectCommands {
  private held: string[] | undefined
  private readonly last: string
  private seen = ''
  /** The last command has come back from the shell: it has been read. */
  echoed = false
  /** OSC 7 has arrived since then: the shell in front still reports where it is. */
  reported = false

  constructor(lines: string[]) {
    this.held = lines
    const last = [...lines].reverse().find((line) => line.trim() !== '') ?? ''
    // Compared as bytes, the way the output is kept: a name in Cyrillic is
    // two bytes to a letter on the wire.
    this.last = Buffer.from(last.trim(), 'utf8').toString('latin1').slice(-ECHO_CHARS)
  }

  /** Whether they have been typed in already. */
  get typed(): boolean {
    return this.held === undefined
  }

  /** The lines to type, once: they are no longer held after this. */
  take(): string[] {
    const lines = this.held ?? []
    this.held = undefined
    return lines
  }

  /** What the host printed. Only output after the commands went in counts. */
  note(raw: Buffer): void {
    if (!this.typed || this.reported) return
    if (this.echoed) {
      if (raw.includes(OSC7_START)) this.reported = true
      return
    }
    this.seen = (this.seen + raw.toString('latin1')).slice(-SEEN_CHARS)
    const at = this.last === '' ? 0 : this.seen.indexOf(this.last)
    if (at < 0) return
    this.echoed = true
    // An answer in the same read as the echo, after it, counts as well.
    if (this.seen.indexOf('\u001b]7;', at + this.last.length) >= 0) this.reported = true
  }
}
