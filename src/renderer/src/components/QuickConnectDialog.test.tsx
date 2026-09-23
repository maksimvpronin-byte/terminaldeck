// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QuickConnectDialog from './QuickConnectDialog'
import { useStore } from '../state/store'

function openDialog(): ReturnType<typeof vi.fn> {
  const openTab = vi.fn()
  useStore.setState({ openTab })
  render(<QuickConnectDialog onClose={() => {}} />)
  return openTab
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('Quick connect', () => {
  it('opens a shell over SSH, as it always has', () => {
    const openTab = openDialog()
    fill('Host', 'db.example')
    fill('Username', 'root')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(openTab.mock.calls[0][1]).toMatchObject({
      kind: 'quick',
      params: { protocol: 'ssh', host: 'db.example', port: 22, username: 'root' }
    })
  })

  it('opens a desktop once RDP is chosen, on the desktop port', () => {
    const openTab = openDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'RDP' }))

    // 22 was only ever the SSH default, and the SSH-only choices go.
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('3389')
    expect(screen.queryByLabelText('Auth method')).toBeNull()

    fill('Host', 'win.example')
    fill('Username', 'CORP\\admin')
    fill('Password', 'secret')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

    expect(openTab.mock.calls[0]).toEqual([
      'CORP\\admin@win.example',
      {
        kind: 'quick',
        params: expect.objectContaining({
          protocol: 'rdp',
          host: 'win.example',
          port: 3389,
          username: 'CORP\\admin',
          authMethod: 'password',
          password: 'secret'
        })
      }
    ])
  })

  it('leaves a port somebody typed alone when the protocol changes', () => {
    openDialog()
    fill('Port', '2222')
    fireEvent.click(screen.getByRole('radio', { name: 'RDP' }))
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('2222')
  })
})
