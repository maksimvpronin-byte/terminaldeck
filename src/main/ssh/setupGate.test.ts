import { describe, it, expect } from 'vitest'
import { SetupGate, looksLikePrompt } from './setupGate'

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')
const text = (b: Buffer): string => b.toString('utf8')
const LINE = '__td7(){ printf x; }; __td7'
const OSC7 = '\u001b]7;file://box/home/max\u001b\\'

describe('SetupGate', () => {
  it('holds output until the shell answers, then cuts the echo out', () => {
    const g = new SetupGate(buf(LINE))
    expect(text(g.push(buf(`${LINE.slice(0, 10)}`)))).toBe('')
    expect(text(g.push(buf(`${LINE.slice(10)}\r\n`)))).toBe('')
    const out = text(g.push(buf(`${OSC7}[max@box ~]$ `)))
    expect(out).toBe(`\r\u001b[K${OSC7}[max@box ~]$ `)
    expect(g.done).toBe(true)
    expect(g.answered).toBe(true)
  })

  it('cuts an echo however the line editor drew it', () => {
    const g = new SetupGate(buf(LINE))
    // A redraw that reprints the prompt and backs up with backspaces.
    const drawn = `${LINE.slice(0, 12)}\b\b\r[max@box ~]$ ${LINE}\r\n`
    expect(text(g.push(buf(drawn + OSC7 + '$ ')))).toBe(`\r\u001b[K${OSC7}$ `)
  })

  it('keeps what came before the echo', () => {
    const g = new SetupGate(buf(LINE))
    expect(text(g.push(buf(`late output\r\n${LINE}\r\n${OSC7}$ `)))).toBe(
      `late output\r\n\r\u001b[K${OSC7}$ `
    )
  })

  it('cuts nothing when the echo cannot be found', () => {
    const g = new SetupGate(buf(LINE))
    expect(text(g.push(buf(`x\r\n${OSC7}$ `)))).toBe(`x\r\n${OSC7}$ `)
  })

  it('releases held output on flush, taking out an echo drawn in one piece', () => {
    const g = new SetupGate(buf(LINE))
    g.push(buf(`${LINE}\r\nstill running`))
    expect(text(g.flush())).toBe('still running')
    expect(g.answered).toBe(false)
    expect(text(g.push(buf('after')))).toBe('after')
  })

  it('gives up once too much is held', () => {
    const g = new SetupGate(buf(LINE), 16)
    expect(text(g.push(buf('0123456789abcdefXYZ')))).toBe('0123456789abcdefXYZ')
    expect(g.done).toBe(true)
  })
})

describe('looksLikePrompt', () => {
  it.each(['[max@box ~]$ ', 'root@box:~# ', 'box% ', '\u001b[01;32mmax@box\u001b[00m:~$ ', '> '])(
    'accepts %j',
    (tail) => expect(looksLikePrompt(tail)).toBe(true)
  )
  it.each(['Last login: Tue', 'Password: ', 'Loading profile...\r\n', ''])('rejects %j', (tail) =>
    expect(looksLikePrompt(tail)).toBe(false)
  )
})
