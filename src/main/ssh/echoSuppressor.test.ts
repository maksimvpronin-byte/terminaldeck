import { describe, it, expect } from 'vitest'
import { EchoSuppressor } from './echoSuppressor'

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
const text = (b: Buffer): string => b.toString('utf8')

describe('EchoSuppressor', () => {
  it('removes the echoed line and lets the rest through', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    expect(text(s.push(buf('__td7 setup\r\nmax@box:~$ ')))).toBe('max@box:~$ ')
    // Still watching: a shell that echoed once may yet echo again.
    expect(s.done).toBe(false)
  })

  it('takes the newline with it, so no blank line is left behind', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('X\r\nafter')))).toBe('after')
  })

  it('handles a bare LF as well as CRLF', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('X\nafter')))).toBe('after')
  })

  it('keeps whatever came before the echo', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('prompt$ X\r\nafter')))).toBe('prompt$ after')
  })

  it('waits across reads when the echo is split', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    expect(text(s.push(buf('__td7 se')))).toBe('')
    expect(s.done).toBe(false)
    expect(text(s.push(buf('tup\r\nrest')))).toBe('rest')
    expect(s.done).toBe(false)
  })

  it('passes everything through once it has been released', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    s.push(buf('__td7 setup\r\n'))
    s.flush()
    expect(text(s.push(buf('__td7 setup')))).toBe('__td7 setup')
  })

  /**
   * Until the shell reaches its first prompt the tty driver does the echoing;
   * the line editor then draws the same line again after the prompt. Stopping
   * at the first occurrence left the second one on screen, which is exactly
   * what the user saw on a host with a slow login.
   */
  it('removes the echo again when the shell sends it twice', () => {
    const s = new EchoSuppressor(buf('__td7 setup'))
    expect(text(s.push(buf('__td7 setup\r\nbanner\r\n')))).toBe('banner\r\n')
    expect(s.done).toBe(false)
    expect(text(s.push(buf('prompt$ __td7 setup\r\n')))).toBe('prompt$ ')
  })

  it('does not hold a banner back behind a match that has not come', () => {
    // A login banner can run to screenfuls before the shell says anything of
    // its own. None of it can begin the echo, so none of it waits.
    const s = new EchoSuppressor(buf('__td7 setup'), 16)
    const banner = '0123456789'.repeat(10)
    expect(text(s.push(buf(banner)))).toBe(banner)
    expect(s.done).toBe(false)
    expect(text(s.push(buf('__td7 setup\r\nafter')))).toBe('after')
  })

  it('gives up on a partial match that grows past the budget', () => {
    const s = new EchoSuppressor(buf('__td7 setup and more'), 8)
    expect(text(s.push(buf('__td7 se')))).toBe('')
    expect(text(s.push(buf('tup and')))).toBe('__td7 setup and')
    expect(s.done).toBe(true)
  })

  it('waits for the newline rather than leaving a blank line behind', () => {
    const s = new EchoSuppressor(buf('__td7'))
    expect(text(s.push(buf('__td7')))).toBe('')
    expect(text(s.push(buf('\r\nafter')))).toBe('after')
  })

  it('releases what it was holding when flushed', () => {
    const s = new EchoSuppressor(buf('__td7'))
    expect(text(s.push(buf('__t')))).toBe('')
    expect(text(s.flush())).toBe('__t')
    expect(s.done).toBe(true)
  })

  it('does not corrupt multi-byte characters split across reads', () => {
    // 'ы' is two bytes; a string-based matcher would mangle it here.
    const cyrillic = buf('привет')
    const s = new EchoSuppressor(buf('__td7'))
    const first = s.push(cyrillic.subarray(0, 5))
    const second = s.push(Buffer.concat([cyrillic.subarray(5), buf('__td7\r\n')]))
    expect(text(Buffer.concat([first, second]))).toBe('привет')
  })

  /**
   * The case the class was written for and did not cover, which is why the
   * setup line stayed on screen: the echo is drawn by the shell's line editor,
   * not copied by the pty, and a line longer than the pane is drawn across
   * several rows with bytes of the editor's own at each wrap.
   */
  describe('an echo the shell wrapped while drawing it', () => {
    const setup = '__td7(){ printf; }; fi; __td7'

    it('removes it when a space and a carriage return sit at the margin', () => {
      const s = new EchoSuppressor(buf(setup))
      const wrapped = '__td7(){ printf; }; \r\nfi; __td7'
      expect(text(s.push(buf(`prompt$ ${wrapped}\r\nafter`)))).toBe('prompt$ after')
    })

    it('removes it when the redraw moved the cursor', () => {
      const s = new EchoSuppressor(buf(setup))
      const wrapped = '__td7(){ printf;\u001b[K }; fi; __td7'
      expect(text(s.push(buf(`${wrapped}\r\nafter`)))).toBe('after')
    })

    it('takes the padding before the newline with it', () => {
      const s = new EchoSuppressor(buf('X'))
      expect(text(s.push(buf('X   \r\nafter')))).toBe('after')
    })

    it('waits across reads when a wrapped echo is split', () => {
      const s = new EchoSuppressor(buf(setup))
      expect(text(s.push(buf('__td7(){ printf; }; \r')))).toBe('')
      expect(s.done).toBe(false)
      expect(text(s.push(buf('\nfi; __td7\r\nrest')))).toBe('rest')
    })
  })

  /**
   * The other half of being lenient: spaces are only the margin's when a
   * newline follows them. Otherwise they are the host's, and eating them takes
   * a bite out of the user's own output.
   */
  it('leaves spaces after the echo alone when they are not padding', () => {
    const s = new EchoSuppressor(buf('X'))
    expect(text(s.push(buf('X   after')))).toBe('   after')
  })

  it('does not treat an ordinary difference as something a redraw inserted', () => {
    const s = new EchoSuppressor(buf('__td7 setup'), 32)
    // The `X` is not a wrap, a newline or an escape, so this is a different
    // line and no amount of leniency should make it match.
    expect(text(s.push(buf('__td7 Xsetup and a screenful more of output')))).toBe(
      '__td7 Xsetup and a screenful more of output'
    )
  })

  it('does nothing when given an empty expectation', () => {
    const s = new EchoSuppressor(Buffer.alloc(0))
    expect(s.done).toBe(true)
    expect(text(s.push(buf('anything')))).toBe('anything')
  })
})
