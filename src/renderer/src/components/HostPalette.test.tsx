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

describe('the host palette asked from the command line', () => {
  it('offers only the hosts `-s` found, though the box search would not find them', () => {
    Element.prototype.scrollIntoView = () => undefined
    useStore.setState({ sessions: [host('web-01'), host('web-02'), host('db')] })
    // Found through DNS: the box's own search knows nothing of 10.0.0.7.
    render(
      <HostPalette
        onClose={() => undefined}
        request={{ query: '10.0.0.7', ids: ['web-01', 'web-02'] }}
      />
    )
    expect(screen.getByRole('textbox')).toHaveValue('10.0.0.7')
    expect(screen.getByText('web-01')).toBeInTheDocument()
    expect(screen.getByText('web-02')).toBeInTheDocument()
    expect(screen.queryByText('db')).not.toBeInTheDocument()
    expect(screen.getByText(/Several hosts fit “10.0.0.7”/)).toBeInTheDocument()
  })

  it('says a host it does not know is not known', () => {
    useStore.setState({ sessions: [host('web-01')] })
    render(<HostPalette onClose={() => undefined} request={{ query: 'nope.nsd.ru', ids: [] }} />)
    expect(screen.getByText(/“nope.nsd.ru” is not among the saved hosts/)).toBeInTheDocument()
  })

  it('searches as usual once the query is changed', () => {
    useStore.setState({ sessions: [host('web-01'), host('db')] })
    render(<HostPalette onClose={() => undefined} request={{ query: 'nope', ids: [] }} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'db' } })
    expect(screen.getByText('db')).toBeInTheDocument()
  })
})
