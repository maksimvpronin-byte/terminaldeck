// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { confirmAction } from './confirm'

describe('confirmAction', () => {
  it('answers as confirm did, and gives the keyboard back either way', () => {
    const refocus = vi.fn()
    window.td.ui.refocus = refocus

    const dialog = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(confirmAction('Delete?')).toBe(true)
    expect(confirmAction('Delete?')).toBe(false)

    expect(dialog).toHaveBeenCalledWith('Delete?')
    expect(refocus).toHaveBeenCalledTimes(2)
  })

  // The refocus has to follow the dialog, not precede it: before it, there is
  // nothing to repair yet.
  it('refocuses only once the dialog has closed', () => {
    const order: string[] = []
    window.td.ui.refocus = () => order.push('refocus')
    vi.spyOn(window, 'confirm').mockImplementation(() => {
      order.push('confirm')
      return true
    })

    confirmAction('Close?')

    expect(order).toEqual(['confirm', 'refocus'])
  })
})
