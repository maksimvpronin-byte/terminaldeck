import { describe, expect, it } from 'vitest'
import { type PagerScreen, wheelArrows, wheelGoesToPager, wheelRows } from './pagerWheel'

// `sudo journalctl`: less -X on the normal screen, its prompt on the last row.
const journal: PagerScreen = {
  buffer: 'normal',
  scrolledBack: false,
  cursorOnLastRow: true,
  cursorLine: 'lines 1-47',
  cursorLineStartsInverse: true
}

describe('wheelGoesToPager', () => {
  it('scrolls journalctl rather than the history above it', () => {
    expect(wheelGoesToPager(journal)).toBe(true)
  })

  it('knows less by its short prompt, which is not in reverse video', () => {
    expect(wheelGoesToPager({ ...journal, cursorLine: ':', cursorLineStartsInverse: false })).toBe(
      true
    )
  })

  it('leaves a shell prompt to scroll the history', () => {
    expect(
      wheelGoesToPager({
        ...journal,
        cursorLine: 'pronin.mv_adm@awx ~ $',
        cursorLineStartsInverse: false
      })
    ).toBe(false)
  })

  it('leaves the alternate screen to xterm', () => {
    expect(wheelGoesToPager({ ...journal, buffer: 'alternate' })).toBe(false)
  })

  it('keeps scrolling the history once the view is up in it', () => {
    expect(wheelGoesToPager({ ...journal, scrolledBack: true })).toBe(false)
  })

  it('wants the prompt on the bottom row', () => {
    expect(wheelGoesToPager({ ...journal, cursorOnLastRow: false })).toBe(false)
  })

  it('does not take an empty reverse-video row for a prompt', () => {
    expect(wheelGoesToPager({ ...journal, cursorLine: '   ' })).toBe(false)
  })
})

describe('wheelArrows', () => {
  it('sends one arrow a row, in the mode the program asked for', () => {
    expect(wheelArrows(3, true)).toBe('\x1bOB\x1bOB\x1bOB')
    expect(wheelArrows(-2, false)).toBe('\x1b[A\x1b[A')
  })

  it('sends nothing for no rows', () => {
    expect(wheelArrows(0, true)).toBe('')
  })
})

describe('wheelRows', () => {
  it('counts a line-mode wheel in its own lines', () => {
    expect(wheelRows(3, 1, 20, 0)).toEqual({ rows: 3, carry: 0 })
  })

  it('turns pixels into rows by the row height', () => {
    expect(wheelRows(-100, 0, 20, 0)).toEqual({ rows: -5, carry: 0 })
  })

  it('carries what a small trackpad delta leaves to the next one', () => {
    const first = wheelRows(15, 0, 20, 0)
    expect(first.rows).toBe(0)
    const second = wheelRows(15, 0, 20, first.carry)
    expect(second.rows).toBe(1)
    expect(second.carry).toBeCloseTo(0.5)
  })
})
