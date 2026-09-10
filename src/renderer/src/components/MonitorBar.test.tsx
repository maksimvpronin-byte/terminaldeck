// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import MonitorBar from './MonitorBar'

it('stops monitoring a hidden pane and restarts when it returns', () => {
  window.td.monitor.start = vi.fn()
  window.td.monitor.stop = vi.fn()
  window.td.monitor.onStats = () => () => undefined
  const view = render(<MonitorBar connectionId="host" visible={false} />)
  expect(window.td.monitor.start).not.toHaveBeenCalled()
  view.rerender(<MonitorBar connectionId="host" visible />)
  expect(window.td.monitor.start).toHaveBeenCalledTimes(1)
  view.rerender(<MonitorBar connectionId="host" visible={false} />)
  expect(window.td.monitor.stop).toHaveBeenCalledWith('host')
  view.rerender(<MonitorBar connectionId="host" visible />)
  expect(window.td.monitor.start).toHaveBeenCalledTimes(2)
})
