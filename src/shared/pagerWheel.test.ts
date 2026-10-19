import { describe, expect, it } from 'vitest'
import { type PagerScreen, wheelArrows, wheelRows, wheelTarget } from './pagerWheel'

// `sudo journalctl`: less -X on the normal screen, its prompt on the last row.
const journal: PagerScreen = {
  buffer: 'normal',
  scrolledBack: false,
  cursorOnLastRow: true,
  cursorLine: 'lines 1-47',
  cursorLineStartsInverse: true
}

describe('wheelTarget', () => {
  const up = -100
  const down = 100

  it('scrolls journalctl rather than the history above it', () => {
    expect(wheelTarget(journal, down)).toBe('pager')
    expect(wheelTarget(journal, up)).toBe('pager')
  })

  it('knows less by its short prompt, which is not in reverse video', () => {
    expect(wheelTarget({ ...journal, cursorLine: ':', cursorLineStartsInverse: false }, down)).toBe(
      'pager'
    )
  })

  it('leaves a shell prompt to scroll the history', () => {
    const shell = {
      ...journal,
      cursorLine: 'pronin.mv_adm@awx ~ $',
      cursorLineStartsInverse: false
    }
    expect(wheelTarget(shell, up)).toBe('terminal')
  })

  it('keeps scrolling the history once the view is up in it', () => {
    expect(wheelTarget({ ...journal, scrolledBack: true }, down)).toBe('terminal')
  })

  it('wants the prompt on the bottom row', () => {
    expect(wheelTarget({ ...journal, cursorOnLastRow: false }, down)).toBe('terminal')
  })

  it('does not take an empty reverse-video row for a prompt', () => {
    expect(wheelTarget({ ...journal, cursorLine: '   ' }, down)).toBe('terminal')
  })

  it('scrolls less and man on the alternate screen as before', () => {
    expect(wheelTarget({ ...journal, buffer: 'alternate' }, up)).toBe('pager')
  })

  // vi, with the cursor somewhere in the text.
  const vi: PagerScreen = {
    buffer: 'alternate',
    scrolledBack: false,
    cursorOnLastRow: false,
    cursorLine: 'ExecStart=/usr/sbin/zabbix_agent2',
    cursorLineStartsInverse: false
  }

  it('opens the history behind vi on the way up', () => {
    expect(wheelTarget(vi, up)).toBe('history')
  })

  it('sends vi nothing on the way down, where it already is at the bottom', () => {
    expect(wheelTarget(vi, down)).toBe('nothing')
  })

  it('opens the history behind vi with its status line under the cursor', () => {
    const status = { ...vi, cursorOnLastRow: true, cursorLine: '-- INSERT --' }
    expect(wheelTarget(status, up)).toBe('history')
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
