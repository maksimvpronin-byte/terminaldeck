import { describe, expect, it } from 'vitest'
import type { HostCollection } from '../../../shared/types'
import { changedCollections, membershipOf, membershipsOf, withMembership } from './membership'

function collection(id: string, hostIds: string[]): HostCollection {
  return { id, name: id, hostIds, createdAt: 0, updatedAt: 0 }
}

describe('membershipOf', () => {
  it('tells all, some and none apart', () => {
    const release = collection('r', ['a', 'b', 'x'])
    expect(membershipOf(release, ['a', 'b'])).toBe('all')
    expect(membershipOf(release, ['a', 'c'])).toBe('some')
    expect(membershipOf(release, ['c'])).toBe('none')
    expect(membershipOf(release, [])).toBe('none')
  })
})

describe('withMembership', () => {
  it('adds the missing hosts at the end, keeping the arranged order', () => {
    const release = collection('r', ['x', 'a'])
    expect(withMembership(release, ['a', 'b'], 'all')?.hostIds).toEqual(['x', 'a', 'b'])
  })

  it('takes every one of the hosts out', () => {
    const release = collection('r', ['x', 'a', 'b'])
    expect(withMembership(release, ['a', 'b'], 'none')?.hostIds).toEqual(['x'])
  })

  it('changes nothing for a partial choice or one already true', () => {
    const release = collection('r', ['a'])
    expect(withMembership(release, ['a', 'b'], 'some')).toBeNull()
    expect(withMembership(release, ['a'], 'all')).toBeNull()
    expect(withMembership(release, ['b'], 'none')).toBeNull()
  })
})

describe('changedCollections', () => {
  it('returns only the collections a dialog actually changed', () => {
    const sets = [collection('one', ['a']), collection('two', []), collection('three', ['a'])]
    const chosen = { ...membershipsOf(sets, ['a']), two: 'all' as const, three: 'none' as const }
    expect(changedCollections(sets, ['a'], chosen)).toEqual([
      collection('two', ['a']),
      collection('three', [])
    ])
  })
})
