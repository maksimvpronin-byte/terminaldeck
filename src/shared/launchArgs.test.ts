import { describe, expect, it } from 'vitest'
import { hostsFromArgv, hostsFromLaunchData } from './launchArgs'

describe('hostsFromArgv', () => {
  it('reads the host after -s', () => {
    expect(hostsFromArgv(['C:\\TD\\TerminalDeck.exe', '-s', 'callforce-stat2.nsd.ru'])).toEqual([
      'callforce-stat2.nsd.ru'
    ])
  })

  it('reads --session, --session= and several of them', () => {
    expect(
      hostsFromArgv(['td', '--session', '10.0.0.5', '-s', 'web-01', '--session=db-01'])
    ).toEqual(['10.0.0.5', 'web-01', 'db-01'])
  })

  it('passes over switches of its own that are not hosts', () => {
    expect(
      hostsFromArgv(['TerminalDeck.exe', '--allow-file-access-from-files', '-s', 'web-01'])
    ).toEqual(['web-01'])
  })

  it('finds nothing in the argv a running copy is given, which is why it is not read', () => {
    // `-s amnezia --session web-01` as Chromium hands it to `second-instance`:
    // every switch first, the words after them.
    expect(
      hostsFromArgv([
        'TerminalDeck.exe',
        '-s',
        '--session',
        '--allow-file-access-from-files',
        'amnezia',
        'web-01'
      ])
    ).toEqual([])
  })

  it('takes nothing from a line that names no host', () => {
    expect(hostsFromArgv(['electron', '.'])).toEqual([])
    expect(hostsFromArgv(['td', '-s'])).toEqual([])
    expect(hostsFromArgv(['td', '-s', '--session', 'web-01'])).toEqual(['web-01'])
  })
})

describe('hostsFromLaunchData', () => {
  it('takes the hosts a second launch handed over', () => {
    expect(hostsFromLaunchData({ hosts: ['amnezia', ' web-01 '] })).toEqual(['amnezia', 'web-01'])
  })

  it('takes nothing but names from it', () => {
    expect(hostsFromLaunchData(undefined)).toEqual([])
    expect(hostsFromLaunchData(null)).toEqual([])
    expect(hostsFromLaunchData('amnezia')).toEqual([])
    expect(hostsFromLaunchData({ hosts: 'amnezia' })).toEqual([])
    expect(
      hostsFromLaunchData({ hosts: ['web-01', 7, null, '', '  ', '--inspect', { a: 1 }] })
    ).toEqual(['web-01'])
  })
})
