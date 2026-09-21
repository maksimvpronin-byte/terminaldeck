// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'

/**
 * The screen itself is stood in for: what is under test is the pane around it,
 * which decides what a retry sends. This one fails at once, as a server does
 * when the password is wrong, and records the password it was handed.
 */
const attempts: Array<string | undefined> = []
vi.mock('./RemoteScreen', () => ({
  default: function FailingScreen({
    password,
    onPhase
  }: {
    password?: string
    onPhase: (phase: { at: 'failed'; reason: string }) => void
  }) {
    useEffect(() => {
      attempts.push(password)
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
