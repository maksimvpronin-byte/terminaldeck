import { describe, it, expect } from 'vitest'
import { RDP_FALLBACK, resolveRdp, rdpInheritedFrom } from './rdpResolution'
import type { SessionGroup } from './types'

const groups: SessionGroup[] = [
  {
    id: 'work',
    name: 'Work',
    parentId: null,
    gatewayHost: 'rdg.example.com',
    gatewayUsername: 'DOMAIN\\gw',
    gatewaySecretRef: 'gw-secret',
    commandAsControl: true
  },
  { id: 'desks', name: 'Desks', parentId: 'work', resolution: 'fixed', desktopWidth: 2560 },
  { id: 'lan', name: 'LAN', parentId: null, inheritRdp: false }
]

describe('resolveRdp', () => {
  it('reaches a host directly when nothing states a gateway', () => {
    expect(resolveRdp({}, null, groups)).toEqual(RDP_FALLBACK)
  })

  it('follows the display when nothing states a magnification', () => {
    expect(resolveRdp({}, 'work', groups).magnification).toBe(0)
  })

  it('inherits a pinned magnification, and lets a host state its own under it', () => {
    const scaled: SessionGroup[] = [
      { id: 'hidpi', name: 'HiDPI', parentId: null, magnification: 150 }
    ]
    expect(resolveRdp({}, 'hidpi', scaled).magnification).toBe(150)
    // Zero is a value here — "follow the display" — not a blank to be inherited.
    expect(resolveRdp({ magnification: 0 }, 'hidpi', scaled).magnification).toBe(0)
    expect(resolveRdp({ magnification: 100 }, 'hidpi', scaled).magnification).toBe(100)
  })

  it('says nothing about density unless a level asks for it', () => {
    expect(resolveRdp({}, 'work', groups).sendDensity).toBe(false)
    const told: SessionGroup[] = [{ id: 'macs', name: 'Macs', parentId: null, sendDensity: true }]
    expect(resolveRdp({}, 'macs', told).sendDensity).toBe(true)
    // False is a value, not a blank: a host under such a group can opt back out.
    expect(resolveRdp({ sendDensity: false }, 'macs', told).sendDensity).toBe(false)
  })

  it('inherits a gateway from the group', () => {
    expect(resolveRdp({}, 'work', groups).gatewayHost).toBe('rdg.example.com')
  })

  it('walks up to a grandparent for a gateway the parent does not state', () => {
    expect(resolveRdp({}, 'desks', groups).gatewayHost).toBe('rdg.example.com')
  })

  it('takes the gateway login from the level that states the gateway', () => {
    // Not picked field by field: a host inheriting one gateway's address and
    // another's password fails as a wrong password and says nothing about why.
    const own = { gatewayUsername: 'someone-else' }
    const resolved = resolveRdp(own, 'work', groups)
    expect(resolved.gatewayHost).toBe('rdg.example.com')
    expect(resolved.gatewayUsername).toBe('DOMAIN\\gw')
  })

  it("uses the host's own gateway login when the host names the gateway", () => {
    const own = { gatewayHost: 'other.example.com', gatewayUsername: 'mine' }
    const resolved = resolveRdp(own, 'work', groups)
    expect(resolved.gatewayHost).toBe('other.example.com')
    expect(resolved.gatewayUsername).toBe('mine')
    // The group's password belongs to the group's gateway, not to this one.
    expect(resolved.gatewaySecretRef).toBeUndefined()
  })

  it('defaults the gateway port to 443', () => {
    expect(resolveRdp({}, 'work', groups).gatewayPort).toBe(443)
  })

  it('mixes a fixed size from one level with a gateway from another', () => {
    const resolved = resolveRdp({}, 'desks', groups)
    expect(resolved.resolution).toBe('fixed')
    expect(resolved.desktopWidth).toBe(2560)
    // Unstated at every level, so the fallback rather than a partial size.
    expect(resolved.desktopHeight).toBe(RDP_FALLBACK.desktopHeight)
  })

  it('inherits the pixel budget, and lets a host state its own', () => {
    const capped: SessionGroup[] = [{ id: 'r', name: 'Slow link', parentId: null, pixelBudget: 1.5 }]
    expect(resolveRdp({}, 'r', capped).pixelBudget).toBe(1.5)
    expect(resolveRdp({ pixelBudget: 8 }, 'r', capped).pixelBudget).toBe(8)
    expect(resolveRdp({}, null, capped).pixelBudget).toBe(RDP_FALLBACK.pixelBudget)
  })

  it('keeps an explicit false rather than treating it as unset', () => {
    expect(resolveRdp({ commandAsControl: false }, 'work', groups).commandAsControl).toBe(false)
    expect(resolveRdp({}, 'work', groups).commandAsControl).toBe(true)
  })

  it('stands alone when the host opts out', () => {
    expect(resolveRdp({ inheritRdp: false }, 'work', groups).gatewayHost).toBeUndefined()
  })

  it('stops at a group that opted out, but keeps that group\'s own values', () => {
    // 'lan' opts out, so nothing above it applies — and it names no gateway.
    expect(resolveRdp({}, 'lan', groups).gatewayHost).toBeUndefined()
  })
})

describe('rdpInheritedFrom', () => {
  it('names the group a blank field would take its value from', () => {
    expect(rdpInheritedFrom({}, 'desks', groups, 'gatewayHost')?.name).toBe('Work')
  })

  it('says nothing when the value is the host\'s own', () => {
    expect(rdpInheritedFrom({ gatewayHost: 'mine' }, 'desks', groups, 'gatewayHost')).toBeUndefined()
  })
})
