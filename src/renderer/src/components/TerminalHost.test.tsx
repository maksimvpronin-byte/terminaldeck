// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

/*
 * xterm draws on a canvas jsdom does not have; the part under test is what the
 * pane says about its session, not the drawing.
 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options = {}
    textarea = undefined
    open(): void {}
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): void {}
    write(): void {}
    writeln(): void {}
    focus(): void {}
    dispose(): void {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
  }
}))

const { default: TerminalHost } = await import('./TerminalHost')

describe('a terminal pane whose session ends', () => {
  /**
   * A desktop pane says its session is gone once it is; a terminal pane never
   * did. The host tree went on marking the host as open, and broadcast went on
   * typing into a session that was no longer there.
   */
  it('says the session is gone, as it said it was there', async () => {
    let status: ((status: string) => void) | undefined
    window.td.ssh.connect = vi.fn().mockResolvedValue({ connectionId: 'c1' })
    window.td.ssh.onStatus = (_id: string, cb: (status: string) => void) => {
      status = cb
      return () => undefined
    }
    window.td.ssh.onData = () => () => undefined
    window.td.ssh.onError = () => () => undefined
    window.td.ssh.ready = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    const onConnected = vi.fn()

    render(
      <TerminalHost
        target={{ kind: 'session', sessionId: 'h1' }}
        active={false}
        onConnected={onConnected}
        onFocus={() => undefined}
        resolveWriteTargets={(own) => [own]}
      />
    )

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith('c1'))
    status!('closed')
    expect(onConnected).toHaveBeenLastCalledWith(undefined)
  })
})
