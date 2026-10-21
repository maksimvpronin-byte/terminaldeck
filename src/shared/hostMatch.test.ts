import { describe, expect, it } from 'vitest'
import { matchHosts, matchResolved } from './hostMatch'

const hosts = [
  { id: 'a', title: 'callforce-stat2.nsd.ru', host: '10.20.0.12' },
  { id: 'b', title: 'awx', host: 'awx.test.local' },
  { id: 'c', title: 'db (prod)', host: '10.20.0.40' },
  { id: 'd', title: 'web-01', host: 'web-01.prod.local' },
  { id: 'e', title: 'web-01', host: 'web-01.test.local' }
]
const ids = (list: { id: string }[]): string[] => list.map((h) => h.id)

describe('matchHosts', () => {
  it('finds a host by its FQDN, in any case and with a trailing dot', () => {
    expect(ids(matchHosts('CallForce-Stat2.nsd.ru.', hosts))).toEqual(['a'])
  })

  it('finds a host by its IP', () => {
    expect(ids(matchHosts('10.20.0.40', hosts))).toEqual(['c'])
  })

  it('takes a short name and its FQDN for one machine, both ways', () => {
    expect(ids(matchHosts('callforce-stat2', hosts))).toEqual(['a'])
    expect(ids(matchHosts('awx.test.local', hosts))).toEqual(['b'])
    expect(ids(matchHosts('awx', hosts))).toEqual(['b'])
  })

  it('returns every host a name fits, for the choice to be made', () => {
    expect(ids(matchHosts('web-01', hosts))).toEqual(['d', 'e'])
  })

  it('prefers the exact name over a short-name match', () => {
    expect(ids(matchHosts('web-01.test.local', hosts))).toEqual(['e'])
  })

  it('does not take part of an address for the address', () => {
    expect(matchHosts('10.20.0', hosts)).toEqual([])
    expect(matchHosts('10.20.0.1', hosts)).toEqual([])
  })

  it('finds nothing for a host it does not know', () => {
    expect(matchHosts('nope.nsd.ru', hosts)).toEqual([])
    expect(matchHosts('  ', hosts)).toEqual([])
  })
})

describe('matchResolved', () => {
  it('finds a host saved by IP from the FQDN DNS gives that IP', () => {
    expect(ids(matchResolved({ addresses: ['10.20.0.40'], names: [] }, hosts))).toEqual(['c'])
  })

  it('finds a host saved by name from the name DNS gives an IP', () => {
    expect(ids(matchResolved({ addresses: [], names: ['awx.test.local'] }, hosts))).toEqual(['b'])
  })

  it('finds nothing when DNS knew nothing', () => {
    expect(matchResolved({ addresses: [], names: [] }, hosts)).toEqual([])
  })
})
