// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'

/*
 * xterm draws on a canvas jsdom does not have; the part under test is what the
 * pane says about its session, not the drawing.
 */
// What the mocked terminal has selected.
let selected = ''

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
    getSelection(): string {
      return selected
    }
    hasSelection(): boolean {
      return selected !== ''
    }
    modes = { mouseTrackingMode: 'none' }
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

describe('a terminal opened again from the tree', () => {
  it('connects a restored pane on a new request, and leaves a live one alone', async () => {
    const connect = vi.fn().mockResolvedValue({ connectionId: 'c2' })
    window.td.ssh.connect = connect
    window.td.ssh.onStatus = () => () => undefined
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
    const props = {
      target: { kind: 'session', sessionId: 'h2' } as const,
      active: false,
      restored: true,
      onConnected: vi.fn(),
      onFocus: () => undefined,
      resolveWriteTargets: (own: string) => [own]
    }
    const view = render(<TerminalHost {...props} wake={5} />)
    // Restored panes wait, and a request from before this pane existed is not new.
    expect(connect).not.toHaveBeenCalled()
    view.rerender(<TerminalHost {...props} wake={6} />)
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(props.onConnected).toHaveBeenCalledWith('c2'))
    view.rerender(<TerminalHost {...props} wake={7} />)
    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('copying a selection as it is made', () => {
  function mount(): HTMLElement {
    window.td.ssh.onStatus = () => () => undefined
    window.td.ssh.onData = () => () => undefined
    window.td.ssh.onError = () => () => undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      }
    )
    const view = render(
      <TerminalHost
        target={{ kind: 'session', sessionId: 'h3' }}
        active={false}
        restored
        onConnected={() => undefined}
        onFocus={() => undefined}
        resolveWriteTargets={(own) => [own]}
      />
    )
    return view.container.querySelector('.terminal-host')!
  }

  /**
   * A drag that ended past the pane's edge left the text selected and the
   * clipboard as it was, and the next paste brought in the copy before.
   */
  it('copies when the drag ends outside the pane', () => {
    const write = vi.fn()
    window.td.clipboard.write = write
    const host = mount()
    selected = 'uptime'
    fireEvent.mouseDown(host, { button: 0 })
    fireEvent.mouseUp(document.body, { button: 0 })
    expect(write).toHaveBeenCalledWith('uptime')
  })

  it('journals the copy as a length, never the text', () => {
    window.td.clipboard.write = vi.fn()
    const journal = vi.fn()
    window.td.diag = journal
    const host = mount()
    selected = 'hunter2'
    fireEvent.mouseDown(host, { button: 0 })
    fireEvent.mouseUp(document.body, { button: 0 })
    const lines = journal.mock.calls.map((call) => call.join(' '))
    expect(lines).toContainEqual(expect.stringContaining('copy by selecting: 7 chars'))
    expect(lines.join('\n')).not.toContain('hunter2')
  })

  it('journals a drag that selected nothing', () => {
    const journal = vi.fn()
    window.td.diag = journal
    const host = mount()
    selected = ''
    fireEvent.mouseDown(host, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.mouseUp(document.body, { button: 0, clientX: 80, clientY: 10 })
    expect(journal).toHaveBeenCalledWith(
      'clipboard',
      expect.stringContaining('drag selected nothing, mouse none')
    )
  })

  /**
   * A right click to paste copied what was still selected over what had just
   * been copied elsewhere, and the paste brought that in instead.
   */
  it('leaves the clipboard alone on a right click', () => {
    const write = vi.fn()
    window.td.clipboard.write = write
    const host = mount()
    selected = 'stale'
    fireEvent.mouseDown(host, { button: 2 })
    fireEvent.mouseUp(host, { button: 2 })
    fireEvent.mouseUp(host, { button: 0 })
    expect(write).not.toHaveBeenCalled()
  })
})
