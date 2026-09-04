import { describe, expect, it } from 'vitest'
import { descendsFrom, groupPath } from './groups'
import type { SessionGroup } from './types'

const g = (id: string, parentId: string | null): SessionGroup => ({ id, name: id, parentId })

/** prod → db → replicas, and staging on its own. */
const groups = [g('prod', null), g('db', 'prod'), g('replicas', 'db'), g('staging', null)]

describe('groupPath', () => {
  it('reads from the top down', () => {
    expect(groupPath('replicas', groups)).toBe('prod / db / replicas')
    expect(groupPath(null, groups)).toBe('')
  })
})

describe('descendsFrom', () => {
  it('finds an ancestor however deep it is', () => {
    expect(descendsFrom(groups, 'replicas', 'prod')).toBe(true)
    expect(descendsFrom(groups, 'db', 'prod')).toBe(true)
  })

  it('counts a folder as its own descendant, which is what refuses a drop onto itself', () => {
    expect(descendsFrom(groups, 'prod', 'prod')).toBe(true)
  })

  it('says no for a folder elsewhere in the tree', () => {
    expect(descendsFrom(groups, 'staging', 'prod')).toBe(false)
    expect(descendsFrom(groups, 'prod', 'replicas')).toBe(false)
    expect(descendsFrom(groups, null, 'prod')).toBe(false)
  })

  it('stops on a cycle rather than spinning', () => {
    const cyclic = [g('a', 'b'), g('b', 'a')]
    expect(descendsFrom(cyclic, 'a', 'somewhere-else')).toBe(false)
  })
})
