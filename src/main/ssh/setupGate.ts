import { EchoSuppressor } from './echoSuppressor'

/**
 * Hides the setup line from the moment it is typed until the shell answers it.
 *
 * The echo suppressor alone matched the echo byte by byte, allowing for what a
 * line editor puts between the bytes at a wrap. That is a guess at how the
 * editor draws, and a redraw that reprints the prompt, or moves the cursor with
 * a backspace, defeats it — and then three hundred characters of shell code
 * landed in the user's terminal.
 *
 * This does not guess. Everything the host says after the line is typed is
 * held, and the shell's own answer ends the wait: the first OSC 7 can only come
 * from the line having run, so whatever lies between the start of its echo and
 * that sequence is the echo, however it was drawn. It is cut out, and the
 * prompt line the echo began on is cleared so the prompt the shell prints next
 * lands where the old one stood — the screen looks as though nothing happened.
 *
 * If no answer comes — the line went to a program rather than a shell, or the
 * shell threw its typeahead away — the held output is released through the old
 * byte matcher, which still takes out an echo that was drawn in one piece.
 */

const OSC7_START = Buffer.from('\u001b]7;', 'latin1')

/** Carriage return, then erase the line: the prompt the echo followed goes. */
const CLEAR_LINE = Buffer.from('\r\u001b[K', 'latin1')

/** How much of the line's beginning is looked for to find where the echo starts. */
const HEAD_BYTES = 8

export class SetupGate {
  private held = Buffer.alloc(0)
  private finished = false
  private readonly head: Buffer
  /** Whether the shell has answered, as opposed to the wait being given up. */
  answered = false

  constructor(
    private readonly line: Buffer,
    /** Past this much held output the wait is abandoned, answer or not. */
    private readonly maxHold = 256 * 1024
  ) {
    this.head = line.subarray(0, Math.min(HEAD_BYTES, line.length))
    if (line.length === 0) this.finished = true
  }

  get done(): boolean {
    return this.finished
  }

  /**
   * Feeds a chunk in and returns what may be shown now: nothing while waiting,
   * and on the answer, everything but the echo.
   */
  push(chunk: Buffer): Buffer {
    if (this.finished) return chunk
    this.held = Buffer.concat([this.held, chunk])

    const answer = this.held.indexOf(OSC7_START)
    if (answer >= 0) {
      this.finished = true
      this.answered = true
      const echo = this.held.subarray(0, answer).indexOf(this.head)
      const out =
        // No beginning of the echo to be found: there was no echo, or it was
        // broken up right at its start. Nothing is cut rather than a guess.
        echo < 0
          ? this.held
          : Buffer.concat([this.held.subarray(0, echo), CLEAR_LINE, this.held.subarray(answer)])
      this.held = Buffer.alloc(0)
      return out
    }

    if (this.held.length > this.maxHold) return this.flush()
    return Buffer.alloc(0)
  }

  /**
   * Gives up waiting and releases what is held, with the echo taken out where
   * it can still be recognised byte for byte.
   */
  flush(): Buffer {
    if (this.finished) return Buffer.alloc(0)
    this.finished = true
    const matcher = new EchoSuppressor(this.line)
    const out = Buffer.concat([matcher.push(this.held), matcher.flush()])
    this.held = Buffer.alloc(0)
    return out
  }
}

/**
 * Whether what the host printed last looks like a prompt waiting for input.
 *
 * Typing the setup line at anything else is what loses it: a profile script
 * still running, a password being asked for, a program that flushes the
 * terminal's typeahead. The line then shows up as text on the screen and never
 * runs — which is both of the ways "follow the terminal" was reported broken.
 *
 * Escape sequences are dropped before looking, since a coloured prompt ends in
 * one. A prompt of some other shape simply waits for the cap.
 */
export function looksLikePrompt(tail: string): boolean {
  const plain = tail
    // CSI and OSC sequences, then any lone escape left over.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b./g, '')
    .replace(/\r/g, '')
  return /[$#%>❯»]\s?$/.test(plain)
}
