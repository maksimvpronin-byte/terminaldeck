import { describe, it, expect } from 'vitest'
import { applyOverride } from './overrides'

describe('applyOverride', () => {
  it('shadows only what it states', () => {
    const host = { id: 'h', host: '10.0.0.1', username: 'deploy', port: 2222 }
    expect(applyOverride(host, { nodeId: 'h', username: '', port: 22 })).toEqual({
      ...host,
      port: 22
    })
  })

  /**
   * The inventory's port is ansible_port, the management port: a Windows box
   * switched to RDP here went on dialling WinRM's 5985 for a desktop.
   */
  it('drops the repository port when the protocol is switched', () => {
    const host = { id: 'h', host: 'win1', port: 5985 }
    const switched = applyOverride(host, { nodeId: 'h', protocol: 'rdp' as const })
    expect(switched.port).toBeUndefined()
    expect(switched).toMatchObject({ protocol: 'rdp', host: 'win1' })
    // And the other way: a desktop's own port is not an SSH port.
    const desktop = { id: 'd', host: 'win2', protocol: 'rdp' as const, port: 3390 }
    expect(applyOverride(desktop, { nodeId: 'd', protocol: 'ssh' as const }).port).toBeUndefined()
  })

  it('keeps a port the override states, and one whose protocol is unchanged', () => {
    const host = { id: 'h', host: 'win1', port: 5985 }
    expect(applyOverride(host, { nodeId: 'h', protocol: 'rdp' as const, port: 3391 }).port).toBe(
      3391
    )
    expect(applyOverride(host, { nodeId: 'h', protocol: 'ssh' as const }).port).toBe(5985)
  })
})
