import { describe, it, expect } from 'vitest'
import { stateForRelease } from './updateState'

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

  it('offers a newer release than the one downloaded', () => {
    expect(stateForRelease({ status: 'ready', version: '1.2.0' }, '1.3.0', true)).toEqual({
      status: 'available',
      version: '1.3.0'
    })
  })
})
