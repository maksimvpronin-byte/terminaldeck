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
 * What it does *not* assume any more is that those bytes arrive contiguous.
 * They regularly do not: the echo is not the pty copying input, it is the
 * shell's line editor drawing it, and a line too long for the pane is drawn
 * across several rows with bytes of the editor's own at each wrap — a space and
 * a carriage return at the right margin, sometimes a cursor move. The setup
 * line is around three hundred characters, so in an ordinary pane it always
 * wraps, and a strict search for it simply never matched: the line stayed on
 * screen and the whole class existed for nothing. See `noiseLength`.
 */

/**
 * How many bytes at `at` are the line editor's own rather than the echo's.
 *
 * Zero means this is not something to skip, and the match at hand has failed.
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

  // CSI: ESC [ , parameter bytes, intermediate bytes, then one final byte.
  if (buf[at + 1] === 0x5b) {
    let i = at + 2
    while (i < buf.length && buf[i] >= 0x30 && buf[i] <= 0x3f) i++
    while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x2f) i++
    // Unfinished in what has arrived so far: not skippable yet, so the match
    // fails here and is tried again when the rest turns up.
    if (i < buf.length && buf[i] >= 0x40 && buf[i] <= 0x7e) return i + 1 - at
    return 0
  }

  // ESC with one byte after it — the short forms, of which a redraw uses few.
  const next = buf[at + 1]
  return next !== undefined && next >= 0x40 && next <= 0x5f ? 2 : 0
}

/**
 * Where the echo of `expected` sits in `haystack`, allowing for whatever the
 * line editor put between its bytes.
 *
 * Anchored on the first byte and walked forward: an exact byte is taken as
 * itself first, and only a byte that does not match is offered to
 * `noiseLength`. So a space in the echo matches the space in the expectation
 * rather than being skipped as padding, and only a space with nothing to match
 * is treated as the margin filler it is.
 *
 * A false anchor costs a byte or two before it fails, and the expectation is
 * three hundred distinctive characters long, so there is no realistic way for
 * this to find an echo that is not one.
 */
function findEcho(
  haystack: Buffer,
  expected: Buffer
): { start: number; end: number } | undefined {
  for (let start = 0; start < haystack.length; start++) {
    if (haystack[start] !== expected[0]) continue

    let i = start
    let j = 0
    while (j < expected.length && i < haystack.length) {
      if (haystack[i] === expected[j]) {
        i++
        j++
        continue
      }
      const skip = noiseLength(haystack, i)
      if (skip === 0) break
      i += skip
    }
    if (j === expected.length) return { start, end: i }
  }
  return undefined
}

/**
 * Where the echoed line really ends: past the newline that finished it, and
 * past any spaces a wrap left sitting in front of that newline.
 *
 * The spaces are only padding if a newline follows them. Without one they are
 * the beginning of whatever the host said next, and eating them would take a
 * bite out of the user's own output.
 */
function pastLineEnd(buf: Buffer, from: number): number {
  let i = from
  while (buf[i] === 0x20) i++
  if (buf[i] !== 0x0d && buf[i] !== 0x0a) return from
  if (buf[i] === 0x0d) i++
  if (buf[i] === 0x0a) i++
  return i
}

export class EchoSuppressor {
  private held = Buffer.alloc(0)
  private finished = false

  constructor(
    private readonly expected: Buffer,
    /** Give up once this much has gone by without a match. */
    private readonly maxHold = 8192
  ) {
    if (expected.length === 0) this.finished = true
  }

  get done(): boolean {
    return this.finished
  }

  /**
   * Feeds a chunk in and returns what should reach the terminal. Output is held
   * back only until the echo is found or the budget runs out — a shell with echo
   * disabled must not cost the user their first screenful.
   */
  push(chunk: Buffer): Buffer {
    if (this.finished) return chunk

    this.held = Buffer.concat([this.held, chunk])
    const found = findEcho(this.held, this.expected)
    if (found) {
      this.finished = true
      const after = pastLineEnd(this.held, found.end)
      const out = Buffer.concat([
        this.held.subarray(0, found.start),
        this.held.subarray(after)
      ])
      this.held = Buffer.alloc(0)
      return out
    }

    // Keep only what could still be the start of the echo; release the rest, so
    // a long-running command's output is not delayed behind a match that will
    // never come.
    if (this.held.length > this.maxHold) return this.flush()
    return Buffer.alloc(0)
  }

  /** Stops waiting and releases everything held. */
  flush(): Buffer {
    this.finished = true
    const out = this.held
    this.held = Buffer.alloc(0)
    return out
  }
}
