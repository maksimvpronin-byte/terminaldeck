import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSelectionWatch, type SelectionOwner } from './selectionWatch'

let clipboard = ''
let enabled = true
let focused = true
let target: EventTarget

function owner(): SelectionOwner & { cleared: number } {
  const o = {
    cleared: 0,
    clear() {
      o.cleared++
    }
  }
  return o
}

function watch(): ReturnType<typeof createSelectionWatch> {
  return createSelectionWatch({
    read: () => clipboard,
    enabled: () => enabled,
    focused: () => focused,
    target,
    intervalMs: 500
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  clipboard = ''
  enabled = true
  focused = true
  target = new EventTarget()
})
afterEach(() => vi.useRealTimers())

describe('a selection held on the clipboard', () => {
  it('goes when another program copies and the window comes back', () => {
    const w = watch()
    const pane = owner()
    clipboard = 'df -h'
    w.copied(pane, 'df -h')
    focused = false
    clipboard = 'текстовый текст'
    vi.advanceTimersByTime(2000)
    // Out of the window nothing is read; the return is what notices.
    expect(pane.cleared).toBe(0)
    focused = true
    target.dispatchEvent(new Event('focus'))
    expect(pane.cleared).toBe(1)
  })

  it('goes within half a second when the clipboard changes with the window in front', () => {
    const w = watch()
    const pane = owner()
    clipboard = 'df -h'
    w.copied(pane, 'df -h')
    vi.advanceTimersByTime(500)
    expect(pane.cleared).toBe(0)
    clipboard = 'root@10.0.0.1'
    vi.advanceTimersByTime(500)
    expect(pane.cleared).toBe(1)
  })

  it('goes when another tab copies a selection of its own', () => {
    const w = watch()
    const first = owner()
    const second = owner()
    w.copied(first, 'one')
    w.copied(second, 'two')
    expect(first.cleared).toBe(1)
    expect(second.cleared).toBe(0)
  })

  it('stays when the same tab copies again', () => {
    const w = watch()
    const pane = owner()
    w.copied(pane, 'one')
    w.copied(pane, 'one more')
    expect(pane.cleared).toBe(0)
  })

  it('stays when the same text is copied again, CR LF and all', () => {
    const w = watch()
    const pane = owner()
    clipboard = 'a\nb'
    w.copied(pane, 'a\nb')
    clipboard = 'a\r\nb'
    vi.advanceTimersByTime(1000)
    expect(pane.cleared).toBe(0)
  })

  it('goes when the clipboard holds no text, a picture or files', () => {
    const w = watch()
    const pane = owner()
    w.copied(pane, 'df -h')
    clipboard = ''
    w.check()
    expect(pane.cleared).toBe(1)
  })

  it('is left alone, and nothing read, with the setting off', () => {
    enabled = false
    const read = vi.fn(() => 'other')
    const w = createSelectionWatch({
      read,
      enabled: () => enabled,
      focused: () => true,
      target
    })
    const first = owner()
    const second = owner()
    w.copied(first, 'one')
    w.copied(second, 'two')
    vi.advanceTimersByTime(5000)
    target.dispatchEvent(new Event('focus'))
    expect(first.cleared + second.cleared).toBe(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('stops reading the clipboard once the selection is clicked away', () => {
    const read = vi.fn(() => 'df -h')
    const w = createSelectionWatch({ read, enabled: () => true, focused: () => true, target })
    const pane = owner()
    w.copied(pane, 'df -h')
    vi.advanceTimersByTime(1000)
    const reads = read.mock.calls.length
    w.released(pane)
    vi.advanceTimersByTime(5000)
    expect(read.mock.calls.length).toBe(reads)
  })
})
