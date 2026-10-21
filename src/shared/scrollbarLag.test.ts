import { describe, expect, it } from 'vitest'
import { type ScrollState, scrollbarBehind } from './scrollbarLag'

// Measured in Electron: 38 rows of 18px, `cat` written while the tab was hidden.
const afterHiddenCat: ScrollState = {
  atBottom: true,
  scrollTop: 414,
  scrollHeight: 2844,
  clientHeight: 684,
  rowHeight: 18
}

describe('scrollbarBehind', () => {
  it('sees the bar left where the prompt was before the output', () => {
    expect(scrollbarBehind(afterHiddenCat)).toBe(true)
  })

  it('leaves a bar that is at the end alone', () => {
    expect(scrollbarBehind({ ...afterHiddenCat, scrollTop: 2160 })).toBe(false)
  })

  it('takes a pixel of rounding at a fractional scale for the end', () => {
    // 125%: xterm asks for 2907.2, the browser's heights leave room for 2907.
    expect(
      scrollbarBehind({
        atBottom: true,
        scrollTop: 2906.4,
        scrollHeight: 3606,
        clientHeight: 699,
        rowHeight: 18.4
      })
    ).toBe(false)
  })

  it('leaves the bar alone while someone reads back through the history', () => {
    expect(scrollbarBehind({ ...afterHiddenCat, atBottom: false })).toBe(false)
  })
})
