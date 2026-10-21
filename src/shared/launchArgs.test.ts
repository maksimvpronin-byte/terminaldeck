import { describe, expect, it } from 'vitest'
import { hostsFromArgv } from './launchArgs'

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

  it('passes over the switches Chromium adds to a second launch', () => {
    expect(
      hostsFromArgv([
        'TerminalDeck.exe',
        '--allow-file-access-from-files',
        '--original-process-start-time=13372',
        '-s',
        'web-01'
      ])
    ).toEqual(['web-01'])
  })

  it('takes nothing from a line that names no host', () => {
    expect(hostsFromArgv(['electron', '.'])).toEqual([])
    expect(hostsFromArgv(['td', '-s'])).toEqual([])
    expect(hostsFromArgv(['td', '-s', '--session', 'web-01'])).toEqual(['web-01'])
  })
})
