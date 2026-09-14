import { describe, it, expect, vi } from 'vitest'
import { connectMenuItems, type ConnectMenuOptions } from './connectMenu'

function options(extra: Partial<ConnectMenuOptions> = {}): ConnectMenuOptions {
  return {
    t: ((text: string) => text) as ConnectMenuOptions['t'],
    credentials: [],
    connectAs: vi.fn(),
    showMenu: vi.fn(),
    manageAccounts: vi.fn(),
    openMultiConnect: vi.fn(),
    ...extra
  }
}

describe('connecting in console mode from the host menu', () => {
  it('is not offered to a host that has no console session, such as an SSH one', () => {
    const labels = connectMenuItems(options()).map((item) => item.label)
    expect(labels).toEqual(['Connect as…', 'Connect several times…'])
  })

  it('is offered first to a Windows desktop, and connects straight away', () => {
    const connectConsole = vi.fn()
    const items = connectMenuItems(options({ connectConsole }))
    expect(items.map((item) => item.label)).toEqual([
      'Connect in console mode',
      'Connect as…',
      'Connect several times…'
    ])
    items[0].onSelect()
    expect(connectConsole).toHaveBeenCalledTimes(1)
  })
})
