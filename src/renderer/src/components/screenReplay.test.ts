import { describe, expect, it } from 'vitest'
import { type ReplayCell, type ReplayLine, replayLines, sgrOf } from './screenReplay'

interface Look {
  bold?: boolean
  inverse?: boolean
  fg?: number
  fgRgb?: number
  bg?: number
  width?: number
}

function cell(chars: string, look: Look = {}): ReplayCell {
  return {
    getChars: () => chars,
    getWidth: () => look.width ?? 1,
    isBold: () => (look.bold ? 1 : 0),
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => (look.inverse ? 1 : 0),
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
    isFgRGB: () => look.fgRgb !== undefined,
    isBgRGB: () => false,
    isFgPalette: () => look.fg !== undefined,
    isBgPalette: () => look.bg !== undefined,
    getFgColor: () => look.fgRgb ?? look.fg ?? 0,
    getBgColor: () => look.bg ?? 0
  }
}

/** A row of a terminal `cols` wide, padded with blanks as xterm pads it. */
function line(cells: ReplayCell[], cols: number, isWrapped = false): ReplayLine {
  const all = [...cells]
  while (all.length < cols) all.push(cell(''))
  return { length: cols, isWrapped, getCell: (x) => all[x] }
}

function text(s: string, look?: Look): ReplayCell[] {
  return [...s].map((c) => cell(c, look))
}

function buffer(lines: ReplayLine[]): { getLine: (y: number) => ReplayLine | undefined } {
  return { getLine: (y) => lines[y] }
}

describe('replayLines', () => {
  it('writes plain lines with no trailing blanks', () => {
    const b = buffer([line(text('$ ls'), 10), line(text('a  b'), 10)])
    expect(replayLines(b, 0, 2)).toBe('$ ls\r\na  b')
  })

  it('keeps a colour and resets it before the line ends', () => {
    const b = buffer([line([...text('ok', { fg: 2 }), ...text(' done')], 10)])
    expect(replayLines(b, 0, 1)).toBe('\x1b[0;38;5;2mok\x1b[0m done\x1b[0m')
  })

  it('keeps a blank that has a colour behind it', () => {
    const b = buffer([line([...text('a'), cell(' ', { bg: 4 })], 5)])
    expect(replayLines(b, 0, 1)).toBe('a\x1b[0;48;5;4m \x1b[0m')
  })

  it('leaves a wrapped line for the terminal to wrap, not a newline', () => {
    const b = buffer([line(text('abcd'), 4), line(text('ef'), 4, true), line(text('$'), 4)])
    expect(replayLines(b, 0, 3)).toBe('abcdef\r\n$')
  })

  it('writes a wide character once', () => {
    const b = buffer([line([cell('漢', { width: 2 }), cell('', { width: 0 }), ...text('x')], 6)])
    expect(replayLines(b, 0, 1)).toBe('漢x')
  })

  it('gives empty lines as empty', () => {
    const b = buffer([line(text('a'), 4), line([], 4), line(text('b'), 4)])
    expect(replayLines(b, 0, 3)).toBe('a\r\n\r\nb')
  })
})

describe('sgrOf', () => {
  it('starts from nothing and adds what the cell has', () => {
    expect(sgrOf(cell('x'))).toBe('0')
    expect(sgrOf(cell('x', { bold: true, inverse: true }))).toBe('0;1;7')
  })

  it('gives a true colour as its three parts', () => {
    expect(sgrOf(cell('x', { fgRgb: 0x112233 }))).toBe('0;38;2;17;34;51')
  })
})
