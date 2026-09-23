// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useRef } from 'react'

/**
 * The screen itself is stood in for: what is under test is the pane around it,
 * which decides what a retry sends. This one fails at once, as a server does
 * when the password is wrong, and records the password it was handed.
 */
const attempts: Array<string | undefined> = []
/** Where each attempt was aimed, when it was a desktop typed into Quick connect. */
const quicks: unknown[] = []
vi.mock('./RemoteScreen', () => ({
  default: function FailingScreen({
    password,
    quick,
    onPhase
  }: {
    password?: string
    quick?: unknown
    onPhase: (phase: { at: 'failed'; reason: string }) => void
  }) {
    // Read through a ref: the pane builds this object afresh on each render.
    const aimed = useRef(quick)
    aimed.current = quick
    useEffect(() => {
      attempts.push(password)
      if (aimed.current) quicks.push(aimed.current)
      onPhase({ at: 'failed', reason: 'Authentication failed' })
    }, [password, onPhase])
    return null
  }
}))

const { default: GraphicalHost } = await import('./GraphicalHost')

function open(hasPassword: boolean): void {
  window.td.rdp.login = vi.fn(async () => ({ username: 'admin', hasPassword }))
  window.td.rdp.settings = vi.fn(async () => {
    throw new Error('nothing stated')
  })
  render(<GraphicalHost protocol="rdp" host="win" sessionId="h" paneVisible />)
}

beforeEach(() => {
  attempts.length = 0
  quicks.length = 0
})

describe('a desktop whose password was wrong', () => {
  it('lets a password typed here be corrected rather than sent again', async () => {
    open(false)
    await act(async () => {})

    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'mistyped' } })
    fireEvent.click(screen.getByText('Connect'))
    await act(async () => {})
    expect(attempts).toEqual(['mistyped'])

    fireEvent.click(screen.getByText('Another password…'))
    const field = screen.getByPlaceholderText('Password') as HTMLInputElement
    // Emptied, not the mistake again with the cursor at its end.
    expect(field.value).toBe('')
    fireEvent.change(field, { target: { value: 'right' } })
    fireEvent.click(screen.getByText('Connect'))
    await act(async () => {})

    expect(attempts).toEqual(['mistyped', 'right'])
  })

  it('offers no password to type when a saved one would win over it', async () => {
    open(true)
    await act(async () => {})

    expect(attempts).toEqual([undefined])
    expect(screen.getByText('Try again')).toBeTruthy()
    expect(screen.queryByText('Another password…')).toBeNull()
  })
})

/**
 * A desktop typed into Quick connect: no saved host behind it, so nothing to
 * look up — the address, the login and a typed password are all there is.
 */
describe('a desktop from Quick connect', () => {
  it('connects with what was typed, and asks the main process for nothing saved', async () => {
    window.td.rdp.login = vi.fn()
    window.td.rdp.settings = vi.fn()
    render(
      <GraphicalHost
        protocol="rdp"
        host="10.0.0.5"
        port={3389}
        quick={{ username: 'CORP\\admin', password: 'typed' }}
        paneVisible
      />
    )
    await act(async () => {})

    expect(attempts).toEqual(['typed'])
    expect(quicks).toEqual([{ host: '10.0.0.5', port: 3389, username: 'CORP\\admin' }])
    expect(window.td.rdp.login).not.toHaveBeenCalled()
    expect(window.td.rdp.settings).not.toHaveBeenCalled()
  })

  it('asks for a password left blank, without pointing at a dialog it does not have', async () => {
    render(
      <GraphicalHost protocol="rdp" host="10.0.0.5" quick={{ username: 'admin' }} paneVisible />
    )
    await act(async () => {})

    expect(attempts).toEqual([])
    expect(screen.getByPlaceholderText('Password')).toBeTruthy()
    expect(screen.queryByText(/Save one in its dialog/)).toBeNull()
  })
})
