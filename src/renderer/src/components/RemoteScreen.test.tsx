// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import RemoteScreen from './RemoteScreen'
import { PTR } from '../../../shared/rdpInput'
import type { ForwardedKey } from '../../../shared/types'
import { useShortcuts } from '../hooks/useShortcuts'

let frame: Parameters<typeof window.td.rdp.onDesktopFrame>[1]
let event: Parameters<typeof window.td.rdp.onDesktopEvent>[1]
const putImageData = vi.fn()
const desktopSend = vi.fn()
const setKeyboardCapture = vi.fn()
const forwarded = new Set<(key: ForwardedKey) => void>()
beforeEach(() => {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => null
  })
  Object.defineProperty(navigator, 'keyboard', {
    configurable: true,
    value: { lock: vi.fn(async () => undefined), unlock: vi.fn() }
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number
      ) {}
    }
  )
  window.matchMedia = vi.fn(
    () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    putImageData
  } as unknown as CanvasRenderingContext2D)
  putImageData.mockClear()
  window.td.rdp.desktopStart = vi.fn(async () => 'desktop')
  desktopSend.mockClear()
  window.td.rdp.desktopSend = desktopSend
  window.td.rdp.desktopStop = vi.fn(async () => undefined)
  window.td.rdp.onDesktopFrame = (_id, cb) => {
    frame = cb
    return () => undefined
  }
  window.td.rdp.onDesktopCursor = () => () => undefined
  window.td.rdp.onDesktopEvent = (_id, cb) => {
    event = cb
    return () => undefined
  }
  setKeyboardCapture.mockClear()
  window.td.ui.setKeyboardCapture = setKeyboardCapture
  forwarded.clear()
  window.td.ui.onForwardKey = (cb) => {
    forwarded.add(cb)
    return () => {
      forwarded.delete(cb)
    }
  }
})

describe('desktop shortcuts', () => {
  const props = {
    sessionId: 'host',
    look: null,
    onPhase: vi.fn(),
    onNotice: vi.fn(),
    onMeasured: vi.fn()
  }
  const ctrlR: ForwardedKey = {
    code: 'KeyR',
    control: true,
    shift: false,
    alt: false,
    meta: false
  }
  const forward = (key = ctrlR): void => {
    act(() => {
      for (const cb of forwarded) cb(key)
    })
  }
  const keys = (): unknown[] =>
    desktopSend.mock.calls.filter(([, fields]) => fields.a === 'key').map(([, fields]) => fields)

  it('claims menu shortcuts in a windowed desktop and forwards Ctrl+R with its modifier', async () => {
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
    act(() => screen.focus())
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    desktopSend.mockClear()

    // Ctrl may have been pressed before the pane gained focus.
    forward()
    expect(keys()).toEqual([
      { a: 'key', code: 0x1d, down: true, ext: false },
      { a: 'key', code: 0x13, down: true, ext: false },
      { a: 'key', code: 0x13, down: false, ext: false }
    ])
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    fireEvent.keyUp(screen, { code: 'ControlLeft', key: 'Control' })
    expect(keys().at(-1)).toEqual({ a: 'key', code: 0x1d, down: false, ext: false })
  })

  it('releases held modifiers on Alt+Tab and restores capture when the window returns', async () => {
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    act(() => view.container.querySelector<HTMLElement>('.graphical-screen')!.focus())
    forward()
    fireEvent.blur(window)
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(false)
    expect(keys().at(-1)).toEqual({ a: 'key', code: 0x1d, down: false, ext: false })
    fireEvent.focus(window)
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    desktopSend.mockClear()
    forward()
    expect(keys()[0]).toEqual({ a: 'key', code: 0x1d, down: true, ext: false })
  })

  it('keeps capture after leaving full screen while the desktop still has focus', async () => {
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
    act(() => screen.focus())
    const fullscreen = vi.spyOn(document, 'fullscreenElement', 'get')
    fullscreen.mockReturnValue(screen)
    fireEvent(document, new Event('fullscreenchange'))
    fullscreen.mockReturnValue(null)
    fireEvent(document, new Event('fullscreenchange'))
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    desktopSend.mockClear()
    forward()
    expect(keys()).toHaveLength(3)
  })

  it('delivers a forwarded shortcut only to the focused pane and gives capture back to local inputs', async () => {
    const view = render(
      <>
        <RemoteScreen {...props} visible />
        <RemoteScreen {...props} sessionId="second" visible />
        <input aria-label="local" />
      </>
    )
    await act(async () => {})
    const screens = view.container.querySelectorAll<HTMLElement>('.graphical-screen')
    act(() => screens[0].focus())
    act(() => screens[1].focus())
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    desktopSend.mockClear()
    forward()
    expect(keys()).toHaveLength(3)

    act(() => view.getByLabelText('local').focus())
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(false)
    desktopSend.mockClear()
    forward()
    expect(keys()).toEqual([])
  })

  it('releases capture when the focused desktop is hidden or closed', async () => {
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
    act(() => screen.focus())
    view.rerender(<RemoteScreen {...props} visible={false} />)
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(false)
    desktopSend.mockClear()
    forward()
    expect(keys()).toEqual([])
    view.rerender(<RemoteScreen {...props} visible />)
    act(() => screen.focus())
    view.unmount()
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(false)
    expect(forwarded.size).toBe(0)
  })

  it('keeps the focused desktop captured when an unfocused sibling closes', async () => {
    const first = render(<RemoteScreen {...props} visible />)
    const second = render(<RemoteScreen {...props} sessionId="second" visible />)
    await act(async () => {})
    act(() => second.container.querySelector<HTMLElement>('.graphical-screen')!.focus())
    first.unmount()
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    fireEvent.blur(window)
    fireEvent.focus(window)
    expect(setKeyboardCapture).toHaveBeenLastCalledWith(true)
    desktopSend.mockClear()
    forward()
    expect(keys()).toHaveLength(3)
  })

  it('keeps application shortcuts out of the windowed desktop and restores them outside it', async () => {
    const openSnippets = vi.fn()
    function Shortcuts(): null {
      useShortcuts({ openSnippets, openHelp: vi.fn(), openHosts: vi.fn() })
      return null
    }
    const view = render(
      <>
        <Shortcuts />
        <RemoteScreen {...props} visible />
        <button>Local</button>
      </>
    )
    await act(async () => {})
    const screen = view.container.querySelector<HTMLElement>('.graphical-screen')!
    act(() => screen.focus())
    fireEvent.keyDown(screen, { code: 'ControlLeft', key: 'Control', ctrlKey: true })
    fireEvent.keyDown(screen, { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true })
    expect(openSnippets).not.toHaveBeenCalled()
    expect(keys()).toContainEqual({ a: 'key', code: 0x25, down: true, ext: false })
    const local = view.getByText('Local')
    act(() => local.focus())
    fireEvent.keyDown(local, { code: 'KeyK', key: 'K', ctrlKey: true, shiftKey: true })
    expect(openSnippets).toHaveBeenCalledOnce()
  })
})

describe('console mode', () => {
  it('asks the main process for the administrative session when the pane was opened in it', async () => {
    const props = {
      sessionId: 'host',
      look: null,
      onPhase: vi.fn(),
      onNotice: vi.fn(),
      onMeasured: vi.fn()
    }
    const view = render(<RemoteScreen {...props} admin visible />)
    await act(async () => {})
    expect(window.td.rdp.desktopStart).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'host', admin: true })
    )
    view.unmount()
    vi.unstubAllGlobals()
  })
})

describe('background desktops', () => {
  it('pauses and resumes without reconnecting, and acknowledges a hidden frame without drawing', async () => {
    const props = {
      sessionId: 'host',
      look: null,
      onPhase: vi.fn(),
      onNotice: vi.fn(),
      onMeasured: vi.fn()
    }
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    expect(window.td.rdp.desktopSend).toHaveBeenCalledWith('desktop', { a: 'visible', value: true })
    view.rerender(<RemoteScreen {...props} visible={false} />)
    expect(window.td.rdp.desktopSend).toHaveBeenLastCalledWith('desktop', {
      a: 'visible',
      value: false
    })
    act(() => frame({ x: 0, y: 0, width: 1, height: 1, pixels: new Uint8Array(4) }))
    expect(putImageData).not.toHaveBeenCalled()
    expect(window.td.rdp.desktopSend).toHaveBeenLastCalledWith('desktop', { a: 'ack' })
    view.rerender(<RemoteScreen {...props} visible />)
    expect(window.td.rdp.desktopSend).toHaveBeenLastCalledWith('desktop', {
      a: 'visible',
      value: true
    })
    act(() => frame({ x: 0, y: 0, width: 1, height: 1, pixels: new Uint8Array(4) }))
    expect(putImageData).toHaveBeenCalledTimes(1)
    expect(window.td.rdp.desktopStart).toHaveBeenCalledTimes(1)
    expect(window.td.rdp.desktopStop).not.toHaveBeenCalled()
    view.unmount()
    expect(window.td.rdp.desktopStop).toHaveBeenCalledWith('desktop')
    vi.unstubAllGlobals()
  })

  it('does not turn a vertical trackpad gesture into a horizontal RDP scroll', async () => {
    const props = {
      sessionId: 'host',
      look: null,
      onPhase: vi.fn(),
      onNotice: vi.fn(),
      onMeasured: vi.fn()
    }
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})

    const canvas = view.container.querySelector('canvas')!
    canvas.width = 1000
    canvas.height = 800
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
      right: 1000,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => undefined
    })
    const screen = view.container.querySelector('.graphical-screen')!
    desktopSend.mockClear()

    fireEvent.wheel(screen, {
      clientX: 100,
      clientY: 100,
      deltaX: 20,
      deltaY: -100,
      deltaMode: 0
    })

    const mouseEvents = desktopSend.mock.calls.filter(([, fields]) => fields.a === 'mouse')
    expect(mouseEvents).toEqual([
      ['desktop', { a: 'mouse', flags: PTR.wheel | 120, x: 100, y: 100 }]
    ])
    view.unmount()
  })
})

/**
 * A press on the desktop may end anywhere. Listened for on the pane alone, a
 * release over the toolbar or outside the window never reached the far end,
 * which went on holding the button down.
 */
describe('a mouse button pressed on the desktop', () => {
  const props = {
    sessionId: 'host',
    look: null,
    onPhase: vi.fn(),
    onNotice: vi.fn(),
    onMeasured: vi.fn()
  }

  async function desktop(): Promise<{ screen: Element; unmount: () => void }> {
    const view = render(<RemoteScreen {...props} visible />)
    await act(async () => {})
    const canvas = view.container.querySelector('canvas')!
    canvas.width = 1000
    canvas.height = 800
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 800,
      right: 1000,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => undefined
    })
    desktopSend.mockClear()
    return { screen: view.container.querySelector('.graphical-screen')!, unmount: view.unmount }
  }
  const buttons = (): unknown[] =>
    desktopSend.mock.calls
      .map(([, fields]) => fields)
      .filter((fields) => fields.a === 'mouse' && fields.flags !== PTR.move)

  it('is let go of there when the release happens outside the pane', async () => {
    const { screen, unmount } = await desktop()

    fireEvent.mouseDown(screen, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.mouseUp(document.body, { button: 0, clientX: 1200, clientY: 100 })

    expect(buttons()).toEqual([
      { a: 'mouse', flags: PTR.left | PTR.down, x: 100, y: 100 },
      // Where it was let go of, held to the edge of the desktop.
      { a: 'mouse', flags: PTR.left, x: 999, y: 100 }
    ])
    unmount()
  })

  it('is let go of once, when the release happens on the pane', async () => {
    const { screen, unmount } = await desktop()

    fireEvent.mouseDown(screen, { button: 2, clientX: 10, clientY: 20 })
    fireEvent.mouseUp(screen, { button: 2, clientX: 10, clientY: 20 })

    expect(buttons()).toEqual([
      { a: 'mouse', flags: PTR.right | PTR.down, x: 10, y: 20 },
      { a: 'mouse', flags: PTR.right, x: 10, y: 20 }
    ])
    unmount()
  })

  it('is let go of when the window loses focus with the button still down', async () => {
    const { screen, unmount } = await desktop()

    fireEvent.mouseDown(screen, { button: 0, clientX: 30, clientY: 40 })
    fireEvent.blur(window)
    // A release the window never saw arrives after it comes back; nothing more goes.
    fireEvent.mouseUp(document.body, { button: 0, clientX: 30, clientY: 40 })

    expect(buttons()).toEqual([
      { a: 'mouse', flags: PTR.left | PTR.down, x: 30, y: 40 },
      { a: 'mouse', flags: PTR.left, x: 30, y: 40 }
    ])
    unmount()
  })
})

describe('a file copy that failed', () => {
  /**
   * The reason is translated and the path is not, and both have to survive:
   * this notification is the whole of what anyone will see, on a machine
   * nobody can attach a debugger to, and a reason without the path it is about
   * names four possible causes instead of one.
   */
  it('shows the reason and the path the client named', async () => {
    const view = render(
      <RemoteScreen
        sessionId="host"
        look={null}
        onPhase={vi.fn()}
        onNotice={vi.fn()}
        onMeasured={vi.fn()}
        visible
      />
    )
    await act(async () => {})
    await act(async () => {
      event({
        e: 'clipboard-transfer',
        state: 'error',
        detail: 'Cannot open the copied files on this computer',
        where: 'file:////server/share/a.txt'
      })
    })

    const shown = view.container.textContent ?? ''
    expect(shown).toContain('file:////server/share/a.txt')
    expect(shown).toContain('Cannot open the copied files on this computer')
  })
})
