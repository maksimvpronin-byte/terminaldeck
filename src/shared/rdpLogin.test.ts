import { describe, it, expect } from 'vitest'
import { splitLogin } from './rdpLogin'

describe('splitLogin', () => {
  it('separates a NetBIOS domain from the account', () => {
    expect(splitLogin('CORP\\anna')).toEqual({ domain: 'CORP', username: 'anna' })
  })

  it('leaves a principal name whole', () => {
    // Splitting this produces a domain the far end cannot resolve, and the
    // only symptom is "logon failure".
    expect(splitLogin('anna@corp.example')).toEqual({ username: 'anna@corp.example' })
  })

  it('leaves a bare name alone', () => {
    expect(splitLogin('anna')).toEqual({ username: 'anna' })
  })

  it('takes the last slash, so a domain with one does not lose the account', () => {
    expect(splitLogin('CORP\\EU\\anna')).toEqual({ domain: 'CORP\\EU', username: 'anna' })
  })

  it('ignores space around what was typed', () => {
    expect(splitLogin('  CORP\\anna  ')).toEqual({ domain: 'CORP', username: 'anna' })
  })

  it('does not treat a leading slash as a domain', () => {
    expect(splitLogin('\\anna')).toEqual({ username: '\\anna' })
  })
})
