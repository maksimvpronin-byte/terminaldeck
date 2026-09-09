/**
 * Hides the echo of a line we typed into the shell ourselves.
 *
 * A pty echoes whatever is written to it, so the setup line that makes a shell
 * report its directory comes straight back and lands on the user's screen. They
 * did not type it and cannot act on it, so it is noise — but it is *our* noise,
 * and we know the exact bytes, so it can be taken back out of the stream.
 *
 * Works on bytes rather than text on purpose: output around it may be UTF-8 and
 * a multi-byte character can straddle two reads, which string matching would
 * mangle.
 *
 * What it does *not* assume is that those bytes arrive contiguous. They
 * regularly do not: the echo is not the pty copying input, it is the shell's
 * line editor drawing it, and a line too long for the pane is drawn across
 * several rows with bytes of the editor's own at each wrap — a space and a
 * carriage return at the right margin, sometimes a cursor move. The setup line
 * is around three hundred characters, so in an ordinary pane it always wraps,
 * and a strict search for it simply never matched. See `noiseLength`.
 *
 * Nor does it assume the echo comes back once. Until the shell reaches its
 * first prompt the tty driver is the one echoing, and the line editor then
 * redraws the same line after the prompt: the same bytes arrive twice, from two
 * different places. So every occurrence is removed, until the caller releases
 * the suppressor.
 *
 * And it holds back only what could still turn into the echo. A login banner
 * can run to several screenfuls before the shell says anything of its own, and
 * an earlier version queued all of it behind the match — then gave up on a
 * byte budget and let the echo through anyway. Bytes that cannot begin the
 * expectation are decided immediately and passed on.
 */

/**
 * How many bytes at `at` are the line editor's own rather than the echo's.
 *
 * Zero means this is not something to skip, and the match at hand has failed.
 * `-1` means it might well be, but not all of it has arrived — the caller waits
 * instead of deciding.
 *
 * The three literals are the ones a wrap actually produces. The escape
 * sequences are here because a redraw is entitled to move the cursor, and
 * skipping one costs nothing: the setup line contains no escape byte of its
 * own — its `\033` is four ordinary characters, backslash and three digits,
 * which is exactly what makes it printable in the first place.
 */
function noiseLength(buf: Buffer, at: number): number {
  const byte = buf[at]
  if (byte === 0x0d || byte === 0x0a || byte === 0x20) return 1
  if (byte !== 0x1b) return 0
  if (at + 1 >= buf.length) return -1

  // CSI: ESC [ , parameter bytes, intermediate bytes, then one final byte.
  if (buf[at + 1] === 0x5b) {
    let i = at + 2
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x3f) i++
    while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x2f) i++
    if (i >= buf.length) return -1
    return buf[i] >= 0x40 && buf[i] <= 0x7e ? i + 1 - at : 0
  }

  // ESC with one byte after it — the short forms, of which a redraw uses few.
  const next = buf[at + 1]
  return next >= 0x40 && next <= 0x5f ? 2 : 0
}

type Walk =
  /** The echo is here, and ends before `end`. */
  | { outcome: 'match'; end: number }
  /** Could still be the echo; the bytes to say either way have not arrived. */
  | { outcome: 'pending' }
  /** Not the echo. */
  | { outcome: 'dead' }

/**
 * Walks the expectation against `buf` from `start`, allowing for whatever the
 * line editor put between its bytes.
 *
 * An exact byte is taken as itself first, and only a byte that does not match
 * is offered to `noiseLength`. So a space in the echo matches the space in the
 * expectation rather than being skipped as padding, and only a space with
 * nothing to match is treated as the margin filler it is.
 *
 * A false start costs a byte or two before it dies, and the expectation is
 * three hundred distinctive characters long, so there is no realistic way for
 * this to find an echo that is not one.
 */
function walk(buf: Buffer, start: number, expected: Buffer): Walk {
  let i = start
  let j = 0
  while (j < expected.length) {
    if (i >= buf.length) return { outcome: 'pending' }
    if (buf[i] === expected[j]) {
      i++
      j++
      continue
    }
    const skip = noiseLength(buf, i)
    if (skip === 0) return { outcome: 'dead' }
    if (skip < 0) return { outcome: 'pending' }
    i += skip
  }
  return { outcome: 'match', end: i }
}

/**
 * Where the echoed line really ends: past the newline that finished it, and
 * past any spaces a wrap left sitting in front of that newline.
 *
 * The spaces are only padding if a newline follows them. Without one they are
 * the beginning of whatever the host said next, and eating them would take a
 * bite out of the user's own output.
 *
 * `-1` means the answer is not in yet — the bytes ran out among the spaces, or
 * between a carriage return and its line feed. Cutting there would leave the
 * newline behind as a blank line, so the caller waits for the rest.
 */
function pastLineEnd(buf: Buffer, from: number): number {
  let i = from
  while (i < buf.length && buf[i] === 0x20) i++
  if (i >= buf.length) return -1
  if (buf[i] === 0x0a) return i + 1
  if (buf[i] !== 0x0d) return from
  i++
  if (i >= buf.length) return -1
  return buf[i] === 0x0a ? i + 1 : i
}

export class EchoSuppressor {
  private held = Buffer.alloc(0)
  private finished = false

  constructor(
    private readonly expected: Buffer,
    /**
     * Give up once a match that never completes has held back this much. Only
     * a live partial is ever held, so this is a backstop against a stream that
     * teases the expectation forever, not the ordinary budget it once was.
     */
    private readonly maxHold = 8192
  ) {
    if (expected.length === 0) this.finished = true
  }

  get done(): boolean {
    return this.finished
  }

  /**
   * Feeds a chunk in and returns what should reach the terminal.
   *
   * Everything that cannot be the echo leaves at once; what could still become
   * it waits for the next read. The suppressor keeps working until it is
   * flushed, because the same line can be echoed more than once.
   */
  push(chunk: Buffer): Buffer {
    if (this.finished) return chunk
    this.held = Buffer.concat([this.held, chunk])

    const out: Buffer[] = []
    let decided = 0
    let at = 0
    let holdFrom = -1

    while (at < this.held.length) {
      if (this.held[at] !== this.expected[0]) {
        at++
        continue
      }
      const found = walk(this.held, at, this.expected)
      if (found.outcome === 'dead') {
        at++
        continue
      }
      if (found.outcome === 'pending') {
        holdFrom = at
        break
      }
      const after = pastLineEnd(this.held, found.end)
      if (after < 0) {
        holdFrom = at
        break
      }
      out.push(this.held.subarray(decided, at))
      decided = after
      at = after
    }

    const keepFrom = holdFrom < 0 ? this.held.length : holdFrom
    out.push(this.held.subarray(decided, keepFrom))
    this.held = this.held.subarray(keepFrom)
    if (this.held.length > this.maxHold) out.push(this.flush())
    return Buffer.concat(out)
  }

  /** Stops watching for the echo and releases anything still held. */
  flush(): Buffer {
    this.finished = true
    const out = this.held
    this.held = Buffer.alloc(0)
    return out
  }
}
