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
 * prompt the echo followed is cleared so the prompt the shell prints next
 * lands where the old one stood — the screen looks as though nothing happened.
 *
 * All of that prompt, not only its last line. A prompt on two lines —
 * `user@host ~`, then `$` under it — kept its first line when only the line
 * the cursor stood on was cleared, and the new prompt printed both under it:
 * the first line twice, as though Enter had been pressed on connecting. So
 * after the answer the gate waits for the new prompt too, counts the lines it
 * takes, and climbs that many before it is drawn. The shell prints the same
 * prompt both times, so the count is the old prompt's as well.
 *
 * If no answer comes — the line went to a program rather than a shell, or the
 * shell threw its typeahead away — the held output is released through the old
 * byte matcher, which still takes out an echo that was drawn in one piece.
 */

const OSC7_START = Buffer.from('\u001b]7;', 'latin1')

/** Carriage return, then erase the line: the prompt the echo followed goes. */
const CLEAR_LINE = '\r\u001b[K'
/** Up a line, and erase that one too. */
const CLEAR_LINE_ABOVE = '\u001b[A\u001b[K'
/**
 * The most lines of an old prompt taken back. A prompt taller than this is
 * rare, and a miscount climbing further would eat the output above it.
 */
const MAX_PROMPT_LINES = 4

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
  /** Where the shell's answer begins in what is held, once it has come. */
  private answer = -1

  /**
   * The shell has answered and the gate is waiting for the prompt after it.
   * Brief: the prompt follows the answer at once, so a caller holding output
   * on a timer can shorten it.
   */
  get answering(): boolean {
    return !this.finished && this.answer >= 0
  }

  push(chunk: Buffer): Buffer {
    if (this.finished) return chunk
    this.held = Buffer.concat([this.held, chunk])

    if (this.answer < 0) this.answer = this.held.indexOf(OSC7_START)
    if (this.answer >= 0) {
      const after = this.held.subarray(this.answer).toString('latin1')
      if (looksLikePrompt(after)) return this.release()
    }

    if (this.held.length > this.maxHold) return this.flush()
    return Buffer.alloc(0)
  }

  /**
   * Gives up waiting and releases what is held. Answered, that is the answer
   * and whatever of the prompt has come; unanswered, the output with the echo
   * taken out where it can still be recognised byte for byte.
   */
  flush(): Buffer {
    if (this.finished) return Buffer.alloc(0)
    if (this.answer >= 0) return this.release()
    this.finished = true
    const matcher = new EchoSuppressor(this.line)
    const out = Buffer.concat([matcher.push(this.held), matcher.flush()])
    this.held = Buffer.alloc(0)
    return out
  }

  /** Everything held but the echo, with the old prompt cleared away. */
  private release(): Buffer {
    this.finished = true
    this.answered = true
    const held = this.held
    const answer = this.answer
    this.held = Buffer.alloc(0)
    const echo = held.subarray(0, answer).indexOf(this.head)
    // No beginning of the echo to be found: there was no echo, or it was
    // broken up right at its start. Nothing is cut rather than a guess.
    if (echo < 0) return held
    // Only a prompt the echo followed directly is climbed over. Output that
    // came between them stands where the prompt was, and is not the prompt.
    const lines = echo === 0 ? Math.min(countLines(held.subarray(answer)), MAX_PROMPT_LINES) : 0
    return Buffer.concat([
      held.subarray(0, echo),
      Buffer.from(CLEAR_LINE + CLEAR_LINE_ABOVE.repeat(lines), 'latin1'),
      held.subarray(answer)
    ])
  }
}

/** How many line feeds there are: the lines a prompt takes, less one. */
function countLines(bytes: Buffer): number {
  let n = 0
  for (const byte of bytes) if (byte === 0x0a) n++
  return n
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
