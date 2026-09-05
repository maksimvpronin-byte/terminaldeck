// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useStore } from './state/store'
import App from './App'

/**
 * What a lock has to be, on this side of the application.
 *
 * The workspace is covered rather than unmounted, because unmounting would drop
 * every live session — so the interface behind the overlay is still there, still
 * mounted and still connected. Covering it stops a mouse and nothing else: two
 * presses of Tab out of the password field used to walk the focus into that
 * interface, where a person could switch tabs, open the snippet palette and
 * type into a terminal they could not see.
 */

vi.mock('./components/MainLayout', () => ({
  default: (): JSX.Element => (
    <div>
      <button>a button behind the lock</button>
      <input aria-label="a field behind the lock" />
    </div>
  )
}))

beforeEach(() => {
  window.td.vault.status = () => Promise.resolve({ exists: true, unlocked: true })
  useStore.setState({ vaultLocked: false })
})

/** The background, as the browser sees it: reachable, or beyond reach. */
function background(): HTMLElement {
  return screen.getByRole('button', { name: 'a button behind the lock' })
}

describe('the lock screen', () => {
  it('leaves the workspace alone while the vault is open', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'a button behind the lock' })

    expect(background().closest('[inert]')).toBeNull()
  })

  it('puts the workspace beyond reach of the keyboard', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'a button behind the lock' })

    useStore.setState({ vaultLocked: true })
    await screen.findByRole('button', { name: 'Unlock' })

    // `inert` is what makes this true of the keyboard and not only the mouse:
    // nothing inside can take focus, whatever the tab order says.
    expect(background().closest('[inert]')).not.toBeNull()
  })

  it('keeps the focus on the password field when Tab is pressed', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'a button behind the lock' })
    useStore.setState({ vaultLocked: true })
    const password = await screen.findByLabelText('Master password')

    password.focus()
    await userEvent.tab()
    await userEvent.tab()

    /*
     * Weaker than it looks, and kept anyway: jsdom does not enforce inertness,
     * so this walks the tab order rather than proving the guarantee. The
     * attribute checked above is what Chromium acts on — this is here to catch
     * the day somebody replaces the wrapper with a focus trap that does not
     * hold.
     */
    expect(background().contains(document.activeElement)).toBe(false)
    expect(document.activeElement).not.toBe(screen.getByLabelText('a field behind the lock'))
  })

  it('lets the workspace back when the vault is opened again', async () => {
    render(<App />)
    await screen.findByRole('button', { name: 'a button behind the lock' })
    useStore.setState({ vaultLocked: true })
    await screen.findByRole('button', { name: 'Unlock' })

    useStore.setState({ vaultLocked: false })
    await vi.waitFor(() => expect(background().closest('[inert]')).toBeNull())
  })
})
