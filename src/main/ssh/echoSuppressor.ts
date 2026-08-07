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
 * mangle. Line wrapping is done by the terminal when drawing, not inserted into
 * the stream, so the echoed bytes arrive contiguous.
 */
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
    const at = this.held.indexOf(this.expected)
    if (at >= 0) {
      this.finished = true
      let after = at + this.expected.length
      // The newline that came with it goes too, or an empty line is left behind.
      if (this.held[after] === 0x0d) after++
      if (this.held[after] === 0x0a) after++
      const out = Buffer.concat([this.held.subarray(0, at), this.held.subarray(after)])
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
