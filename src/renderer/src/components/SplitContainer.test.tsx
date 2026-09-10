// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { useStore } from '../state/store'
import { makeLeaf, type PaneNode } from '../state/paneTree'
import SplitContainer from './SplitContainer'

vi.mock('./Pane', () => ({ default: () => <div /> }))
afterEach(() => vi.unstubAllGlobals())
it('coalesces mouse moves and applies the final size on mouseup', () => {
  let resize!: ResizeObserverCallback
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    }
  )
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(++id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key))
  const resizeSplit = vi.fn()
  const original = useStore.getState().resizeSplit
  useStore.setState({ resizeSplit })
  const node: PaneNode = {
    type: 'split',
    id: 'split',
    dir: 'row',
    sizes: [50, 50],
    children: [
      makeLeaf('a', { kind: 'session', sessionId: 'a' }),
      makeLeaf('b', { kind: 'session', sessionId: 'b' })
    ]
  }
  const view = render(<SplitContainer tabId="tab" node={node} />)
  act(() =>
    resize(
      [{ contentRect: { width: 1000, height: 500 } }] as unknown as ResizeObserverEntry[],
      {} as ResizeObserver
    )
  )
  fireEvent.mouseDown(view.container.querySelector('.split-divider-abs')!)
  for (let x = 400; x < 450; x++) fireEvent.mouseMove(window, { clientX: x })
  expect(resizeSplit).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  fireEvent.mouseUp(window)
  expect(resizeSplit).toHaveBeenCalledTimes(1)
  expect(resizeSplit.mock.calls[0][2][0]).toBeCloseTo(44.9)
  expect(frames.size).toBe(0)
  fireEvent.mouseMove(window, { clientX: 600 })
  expect(resizeSplit).toHaveBeenCalledTimes(1)
  view.unmount()
  useStore.setState({ resizeSplit: original })
})
