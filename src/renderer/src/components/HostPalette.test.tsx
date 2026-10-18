// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import HostPalette from './HostPalette'
import { useStore } from '../state/store'
import type { SessionProfile } from '../../../shared/types'

const host = (id: string): SessionProfile => ({
  id,
  name: id,
  host: `${id}.example`,
  groupId: null,
  tags: [],
  logToFile: false,
  portForwards: [],
  createdAt: 0,
  updatedAt: 0
})

/*
 * A click set the cursor on its row and opened at once, and opening read the
 * cursor before the click's own setting had landed: with the arrow keys
 * having moved it since the pointer came in, the row above was opened.
 */
describe('a click in the host palette', () => {
  it('opens the row that was clicked', () => {
    // jsdom lays nothing out, and has no scrolling to bring a row into view.
    Element.prototype.scrollIntoView = () => undefined
    const openHost = vi.fn()
    useStore.setState({ sessions: [host('alpha'), host('bravo')], openHost })
    render(<HostPalette onClose={() => undefined} />)

    const bravo = screen.getByText('bravo').closest('.palette-row')!
    fireEvent.mouseEnter(bravo)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowUp' })
    fireEvent.click(bravo)

    expect(openHost).toHaveBeenCalledTimes(1)
    expect(openHost.mock.calls[0][0]).toBe('bravo')
  })
})
