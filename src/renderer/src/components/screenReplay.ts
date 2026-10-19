/**
 * Lines of an xterm buffer, as the escape sequences that would draw them again.
 *
 * The history view lays a second terminal over a full-screen program and
 * writes into it what the first one holds: its history, then the program's
 * screen. xterm's own serialize addon does this too, but is one more package
 * to fetch for a few dozen lines; these types are the part of xterm's buffer
 * it reads, so a test can hand it lines of its own.
 */

export interface ReplayCell {
  getChars(): string
  getWidth(): number
  isBold(): number
  isDim(): number
  isItalic(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isOverline(): number
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  getFgColor(): number
  getBgColor(): number
}

export interface ReplayLine {
  readonly length: number
  /** The line carries on the one above, where it ran out of columns. */
  readonly isWrapped: boolean
  getCell(x: number): ReplayCell | undefined
}

export interface ReplayBuffer {
  getLine(y: number): ReplayLine | undefined
}

function color(
  params: string[],
  base: number,
  rgb: boolean,
  palette: boolean,
  value: number
): void {
  if (rgb) params.push(`${base};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`)
  else if (palette) params.push(`${base};5;${value}`)
}

/** The SGR parameters that give a cell its look, starting from none. */
export function sgrOf(cell: ReplayCell): string {
  const params = ['0']
  if (cell.isBold()) params.push('1')
  if (cell.isDim()) params.push('2')
  if (cell.isItalic()) params.push('3')
  if (cell.isUnderline()) params.push('4')
  if (cell.isBlink()) params.push('5')
  if (cell.isInverse()) params.push('7')
  if (cell.isInvisible()) params.push('8')
  if (cell.isStrikethrough()) params.push('9')
  if (cell.isOverline()) params.push('53')
  color(params, 38, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor())
  color(params, 48, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor())
  return params.join(';')
}

/**
 * Lines `from` up to, not including, `to`, for a terminal as wide as the one
 * they came from.
 *
 * A line that wrapped is written out to its last column and left for the
 * terminal to wrap again, rather than broken with a newline; every other line
 * loses its plain trailing blanks, which keeps a selection copied out of the
 * history free of them. A blank with a colour behind it is not plain.
 */
export function replayLines(buffer: ReplayBuffer, from: number, to: number): string {
  let out = ''
  for (let y = from; y < to; y++) {
    const line = buffer.getLine(y)
    if (!line) continue
    if (y > from && !line.isWrapped) out += '\r\n'
    const continues = y + 1 < to && !!buffer.getLine(y + 1)?.isWrapped
    let text = ''
    let keep = 0
    let last = '0'
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      // The second half of a wide character, written with the first.
      if (!cell || cell.getWidth() === 0) continue
      const sgr = sgrOf(cell)
      if (sgr !== last) {
        text += `\x1b[${sgr}m`
        last = sgr
      }
      const chars = cell.getChars()
      text += chars || ' '
      if (chars.trim() !== '' || sgr !== '0') keep = text.length
    }
    if (!continues) text = text.slice(0, keep)
    // Nothing carries on to the next line: a newline under a colour paints
    // the new line with it.
    out += text.includes('\x1b[') ? `${text}\x1b[0m` : text
  }
  return out
}
