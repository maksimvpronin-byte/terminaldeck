// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import RemoteScreen from './RemoteScreen'
import { PTR } from '../../../shared/rdpInput'

let frame: Parameters<typeof window.td.rdp.onDesktopFrame>[1]
let event: Parameters<typeof window.td.rdp.onDesktopEvent>[1]
const putImageData = vi.fn()
const desktopSend = vi.fn()
beforeEach(() => {
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
  window.td.ui.onForwardKey = () => () => undefined
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
