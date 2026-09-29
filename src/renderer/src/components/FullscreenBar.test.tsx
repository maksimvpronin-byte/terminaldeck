// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FullscreenBar from './FullscreenBar'

function mount(onClose = vi.fn()): { pane: HTMLElement; onClose: () => void } {
  const pane = document.createElement('div')
  document.body.append(pane)
  render(<FullscreenBar paneId="pane1" title="dc1.example" pane={pane} onClose={onClose} />)
  return { pane, onClose }
}

describe('FullscreenBar', () => {
  beforeEach(() => localStorage.clear())

  it('names the session and carries no native tooltip anywhere', () => {
    const { container } = render(
      <FullscreenBar
        paneId="pane1"
        title="dc1.example"
        pane={document.body}
        onClose={() => undefined}
      />
    )
    expect(screen.getByText('dc1.example')).toBeInTheDocument()
    expect(container.querySelector('[title]')).toBeNull()
  })

  it('closes, minimises and leaves full screen from its buttons', async () => {
    const minimize = vi.fn().mockResolvedValue(undefined)
    window.td.ui.minimizeFullscreen = minimize
    const exit = vi.fn().mockResolvedValue(undefined)
    document.exitFullscreen = exit
    const { pane, onClose } = mount()
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => pane })

    await userEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(minimize).toHaveBeenCalledWith('pane1')
    await userEvent.click(screen.getByRole('button', { name: 'Leave full screen (F11)' }))
    expect(exit).toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close this session' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the focus where it was when a button is pressed', () => {
    mount()
    const button = screen.getByRole('button', { name: 'Minimize' })
    expect(fireEvent.mouseDown(button)).toBe(false)
    expect(button).toHaveAttribute('tabindex', '-1')
  })

  it('remembers being unpinned, and tucks itself away once unpinned', () => {
    vi.useFakeTimers()
    try {
      mount()
      const bar = screen.getByText('dc1.example').parentElement!
      fireEvent.click(screen.getByRole('button', { name: /^Unpin/ }))
      expect(localStorage.getItem('terminaldeck.fullscreenBar.pinned')).toBe('false')
      expect(screen.getByRole('button', { name: /^Pin/ })).toBeInTheDocument()
      // The pointer is still on the pin it just clicked, so the bar stays until it leaves.
      fireEvent.mouseEnter(bar)
      act(() => vi.advanceTimersByTime(3000))
      expect(bar).not.toHaveClass('tucked')
      fireEvent.mouseLeave(bar)
      act(() => vi.advanceTimersByTime(1000))
      expect(bar).toHaveClass('tucked')
    } finally {
      vi.useRealTimers()
    }
  })

  it('comes back for the pointer at the top edge', () => {
    localStorage.setItem('terminaldeck.fullscreenBar.pinned', 'false')
    vi.useFakeTimers()
    try {
      const { pane } = mount()
      const bar = screen.getByText('dc1.example').parentElement!
      act(() => vi.advanceTimersByTime(2000))
      expect(bar).toHaveClass('tucked')
      vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, -28, 200, 28))
      // Along the edge but nowhere near the bar: nothing.
      act(() => {
        pane.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 0 }))
      })
      expect(bar).toHaveClass('tucked')
      act(() => {
        pane.dispatchEvent(new MouseEvent('pointermove', { clientX: 450, clientY: 0 }))
      })
      expect(bar).not.toHaveClass('tucked')
    } finally {
      vi.useRealTimers()
    }
  })
})
