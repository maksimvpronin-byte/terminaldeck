import { describe, it, expect } from 'vitest'
import { errorCode, parseSessions, qualifyUser, shadowArgs, shadowable } from './winSessions'

/**
 * What the enumerator writes: id, station, state and user, separated by tabs.
 *
 * Captured from a Russian host, which is the point of reading the API rather
 * than `qwinsta`. The state is a number here and the account name is Unicode,
 * so neither the host's language nor its console code page is in the way.
 */
const ROWS = [
  '0\tServices\t4\t',
  '1\tConsole\t0\tАдминистратор',
  '3\tRDP-Tcp#1\t0\tadminrdp',
  '4\tRDP-Tcp#2\t4\tmaksim',
  '65537\tRDP-Tcp\t6\t',
  ''
].join('\r\n')

describe('parseSessions', () => {
  it('reads every row', () => {
    expect(parseSessions(ROWS).map((s) => s.id)).toEqual([0, 1, 3, 4, 65537])
  })

  it('names the state in one spelling, whatever the host speaks', () => {
    const states = parseSessions(ROWS).map((s) => s.state)
    expect(states).toEqual(['Disconnected', 'Active', 'Active', 'Disconnected', 'Listen'])
  })

  it('keeps an account name that is not ASCII', () => {
    expect(parseSessions(ROWS).find((s) => s.id === 1)).toEqual({
      id: 1,
      name: 'Console',
      state: 'Active',
      user: 'Администратор'
    })
  })

  it('leaves the user empty where nobody is signed in', () => {
    expect(parseSessions(ROWS).find((s) => s.id === 0)!.user).toBe('')
    expect(parseSessions(ROWS).find((s) => s.id === 65537)!.user).toBe('')
  })

  it('reads nothing out of a message that is not a session', () => {
    // The reason a failed command's output can be handed here safely now: an
    // error message has neither the fields nor a state the API defines, where
    // the old table format let `Ошибка 5 получения имен сеансов` parse as a row.
    expect(parseSessions('Error [5]: Access is denied.')).toEqual([])
    expect(parseSessions('РћС€РёР±РєР° 5 РїРѕР»СѓС‡РµРЅРёСЏ')).toEqual([])
    expect(parseSessions('1\tConsole\t99\tsomebody')).toEqual([])
    expect(parseSessions('')).toEqual([])
  })
})

describe('shadowable', () => {
  it('offers the sessions somebody is signed in to and using', () => {
    expect(shadowable(parseSessions(ROWS)).map((s) => s.id)).toEqual([1, 3])
  })

  it('leaves out a disconnected session, which cannot be shadowed at all', () => {
    // RpcShadow2 answers for one of these with a listener that has nothing
    // behind it: the connection completes and is then dropped without a word.
    expect(shadowable(parseSessions(ROWS)).some((s) => s.id === 4)).toBe(false)
  })

  it('leaves out the listener and the services session', () => {
    const offered = shadowable(parseSessions(ROWS)).map((s) => s.id)
    expect(offered).not.toContain(65537)
    expect(offered).not.toContain(0)
  })
})

describe('qualifyUser', () => {
  it('points a bare name at the host, not at this machine', () => {
    // The whole point: Windows reads an unqualified name as a local account of
    // the computer running the command, and a standalone server then answers
    // 1326 — indistinguishable from a wrong password.
    expect(qualifyUser('administrator', '10.10.10.9')).toBe('10.10.10.9\\administrator')
  })

  it('leaves a name that already names its domain', () => {
    expect(qualifyUser('CONTOSO\\maksim', '10.0.0.1')).toBe('CONTOSO\\maksim')
    expect(qualifyUser('.\\local', '10.0.0.1')).toBe('.\\local')
  })

  it('leaves a UPN alone', () => {
    expect(qualifyUser('maksim@contoso.local', '10.0.0.1')).toBe('maksim@contoso.local')
  })

  it('handles a localised account name', () => {
    expect(qualifyUser('Администратор', 'srv')).toBe('srv\\Администратор')
  })

  it('does not invent a name out of nothing', () => {
    expect(qualifyUser('   ', 'srv')).toBe('')
  })
})

describe('errorCode', () => {
  it('reads the number out of an English message', () => {
    expect(errorCode('System error 1326 has occurred.')).toBe(1326)
  })

  it('reads it out of a translated one', () => {
    // The reason codes are matched rather than words: this arrives in the
    // console codepage and in the machine's own language.
    expect(errorCode('Системная ошибка 1326.')).toBe(1326)
  })

  it('reads a bracketed code, which is how qwinsta reports one', () => {
    // Verbatim from a real host: `Ошибка [5]:Отказано в доступе`.
    expect(errorCode('Error [5]: Access is denied.')).toBe(5)
    expect(errorCode('Error [1722]: RPC server unavailable')).toBe(1722)
  })

  it('says nothing when the output named no code', () => {
    expect(errorCode('The command completed successfully.')).toBeNull()
    expect(errorCode('')).toBeNull()
  })

  it('reads a single-digit code, which is the commonest one there is', () => {
    // `Access denied` is error 5. Requiring three digits made every one of
    // those look like a clean, empty answer.
    expect(errorCode('Error 5: Access is denied.')).toBe(5)
    expect(errorCode('РћС€РёР±РєР° 5')).toBe(5)
  })

  it('finds the number even when the words around it are mojibake', () => {
    // What actually arrives: the message is read in the console codepage, so
    // only the digits survive intact. This is the case that carries the load.
    expect(errorCode('РЎРёСЃС‚РµРјРЅР°СЏ РѕС€РёР±РєР° 1326.')).toBe(1326)
  })
})

describe('shadowArgs', () => {
  it('asks to watch, and nothing more, by default', () => {
    expect(shadowArgs('10.0.0.9', 3, { control: false, skipPrompt: false })).toEqual([
      '/shadow:3',
      '/v:10.0.0.9'
    ])
  })

  it('asks for control when told to', () => {
    expect(shadowArgs('h', 1, { control: true, skipPrompt: false })).toContain('/control')
  })

  it('skips the consent prompt only when asked', () => {
    expect(shadowArgs('h', 1, { control: true, skipPrompt: true })).toContain('/noconsentprompt')
    expect(shadowArgs('h', 1, { control: true, skipPrompt: false })).not.toContain(
      '/noconsentprompt'
    )
  })
})
