import { describe, it, expect } from 'vitest'
import { overtaken, stateForRelease } from './updateState'

describe('a release found again', () => {
  it('is offered when nothing has been done about it', () => {
    expect(stateForRelease({ status: 'idle' }, '1.2.0', true)).toEqual({
      status: 'available',
      version: '1.2.0'
    })
    expect(stateForRelease({ status: 'idle' }, '1.2.0', false)).toEqual({
      status: 'manual',
      version: '1.2.0'
    })
  })

  it('leaves a download in progress alone', () => {
    const downloading = { status: 'downloading', percent: 40 } as const
    expect(stateForRelease(downloading, '1.2.0', true)).toBe(downloading)
  })

  it('leaves a downloaded update ready to install', () => {
    const ready = { status: 'ready', version: '1.2.0' } as const
    expect(stateForRelease(ready, '1.2.0', true)).toBe(ready)
  })

  it('keeps a downloaded update installable when a newer release is out', () => {
    const ready = { status: 'ready', version: '1.2.0' } as const
    expect(stateForRelease(ready, '1.3.0', true)).toBe(ready)
  })

  it('moves a banner left up to the newest release', () => {
    expect(stateForRelease({ status: 'available', version: '1.2.0' }, '1.4.0', true)).toEqual({
      status: 'available',
      version: '1.4.0'
    })
    expect(stateForRelease({ status: 'manual', version: '1.2.0' }, '1.4.0', false)).toEqual({
      status: 'manual',
      version: '1.4.0'
    })
  })

  it('changes nothing when the hourly check finds the release already offered', () => {
    const available = { status: 'available', version: '1.2.0' } as const
    expect(stateForRelease(available, '1.2.0', true)).toBe(available)
  })
})

describe('a downloaded update overtaken by a newer release', () => {
  it('is fetched again only when a different release is out', () => {
    expect(overtaken({ status: 'ready', version: '1.2.0' }, '1.3.0')).toBe(true)
    expect(overtaken({ status: 'ready', version: '1.2.0' }, '1.2.0')).toBe(false)
  })

  it('is only a question for an update already downloaded', () => {
    expect(overtaken({ status: 'available', version: '1.2.0' }, '1.3.0')).toBe(false)
    expect(overtaken({ status: 'downloading', percent: 50 }, '1.3.0')).toBe(false)
    expect(overtaken({ status: 'idle' }, '1.3.0')).toBe(false)
  })
})
