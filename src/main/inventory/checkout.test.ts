import { describe, it, expect } from 'vitest'
import { insideCheckout } from './checkout'

describe('insideCheckout', () => {
  it('accepts what is inside, including the checkout itself', () => {
    expect(insideCheckout('/repos/one', '/repos/one')).toBe(true)
    expect(insideCheckout('/repos/one', '/repos/one/inventories/prod/hosts.yml')).toBe(true)
  })

  it('refuses a path that climbs out', () => {
    expect(insideCheckout('/repos/one', '/repos/one/../../etc')).toBe(false)
    expect(insideCheckout('/repos/one', '/etc/passwd')).toBe(false)
  })

  it('is not fooled by a sibling whose name starts the same way', () => {
    // `/repos/one-secret` begins with `/repos/one`, and a prefix test without
    // the separator would let it through.
    expect(insideCheckout('/repos/one', '/repos/one-secret/a.yml')).toBe(false)
  })
})
