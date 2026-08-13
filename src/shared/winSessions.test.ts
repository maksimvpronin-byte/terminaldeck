import { describe, it, expect } from 'vitest'
import { errorCode, parseSessions, qualifyUser, shadowArgs, shadowable } from './winSessions'

/** Real `qwinsta /server:` output from an English host. */
const ENGLISH = [
  ' SESSIONNAME       USERNAME                 ID  STATE   TYPE        DEVICE',
  ' services                                    0  Disc',
  '>console           Administrator             1  Active',
  ' rdp-tcp#3         maksim                    3  Active',
  ' rdp-tcp                                 65536  Listen',
  ''
].join('\r\n')

/** The same table on a Russian host, which is why headings are not matched. */
const RUSSIAN = [
  ' СЕАНС             ПОЛЬЗОВАТЕЛЬ             ID  СОСТОЯНИЕ ТИП         УСТРОЙСТВО',
  ' services                                    0  Disc',
  '>console           Администратор             1  Активно',
  ' rdp-tcp#2         maksim                    2  Активно',
  ''
].join('\r\n')

/**
 * Captured verbatim from `qwinsta` on a real Windows 11 machine, trailing
 * spaces and all. The hand-written tables above are what the format is believed
 * to look like; this one is what it actually is.
 */
const CAPTURED =
  ' SESSIONNAME               USERNAME                 ID  STATE   TYPE        DEVICE \r\n' +
  ' services                                            0  Disc                        \r\n' +
  '>console                   Fidel                     1  Active'

describe('a table captured from a real host', () => {
  it('reads both rows and neither heading', () => {
    expect(parseSessions(CAPTURED).map((s) => s.id)).toEqual([0, 1])
  })

  it('gets the logged-on user off the console row', () => {
    expect(parseSessions(CAPTURED).find((s) => s.id === 1)).toMatchObject({
      name: 'console',
      user: 'Fidel',
      state: 'Active',
      current: true
    })
  })

  it('offers only the console session, not services', () => {
    expect(shadowable(parseSessions(CAPTURED)).map((s) => s.user)).toEqual(['Fidel'])
  })
})

describe('parseSessions', () => {
  it('reads every row of an ordinary table', () => {
    const sessions = parseSessions(ENGLISH)
    expect(sessions.map((s) => s.id)).toEqual([0, 1, 3, 65536])
  })

  it('drops the heading without needing to recognise it', () => {
    // The heading carries no bare integer, which is the whole trick: it fails
    // the same test that finds the id, in any language.
    expect(parseSessions(ENGLISH).some((s) => s.name === 'SESSIONNAME')).toBe(false)
  })

  it('separates the session name from the user', () => {
    const console = parseSessions(ENGLISH).find((s) => s.id === 1)!
    expect(console).toMatchObject({ name: 'console', user: 'Administrator', state: 'Active' })
  })

  it('leaves the user empty when nobody is logged on', () => {
    // One token before the id is a session name, never a username: the blank
    // column belongs to the user.
    const services = parseSessions(ENGLISH).find((s) => s.id === 0)!
    expect(services).toMatchObject({ name: 'services', user: '' })
  })

  it('marks the session the query came from', () => {
    const sessions = parseSessions(ENGLISH)
    expect(sessions.find((s) => s.id === 1)!.current).toBe(true)
    expect(sessions.find((s) => s.id === 3)!.current).toBe(false)
  })

  it('reads a translated table exactly as well', () => {
    const sessions = parseSessions(RUSSIAN)
    expect(sessions.map((s) => s.id)).toEqual([0, 1, 2])
    expect(sessions.find((s) => s.id === 1)).toMatchObject({
      user: 'Администратор',
      state: 'Активно'
    })
  })

  it('returns nothing for output that is not a table', () => {
    // A refused query prints an error, and it must not become a fake session.
    expect(parseSessions('Error [5]: Access is denied.')).toEqual([])
    expect(parseSessions('')).toEqual([])
  })

  it('cannot always tell an error message from a row, which is why callers check the exit code', () => {
    // Documented rather than fixed here. A translated error read in the console
    // codepage — `Ошибка 5 получения имен сеансов` — has a bare integer in the
    // middle of it and is shaped exactly like a session row. Nothing about the
    // text distinguishes them, so the caller must not offer this function the
    // output of a command that failed.
    const mojibake = 'РћС€РёР±РєР° 5 РїРѕР»СѓС‡РµРЅРёСЏ РёРјРµРЅ СЃРµР°РЅСЃРѕРІ'
    expect(parseSessions(mojibake).length).toBeGreaterThan(0)
  })
})

describe('shadowable', () => {
  it('offers only sessions somebody is actually using', () => {
    const offered = shadowable(parseSessions(ENGLISH))
    expect(offered.map((s) => s.id)).toEqual([1, 3])
  })

  it('leaves out the listener, which has an id but no session behind it', () => {
    expect(shadowable(parseSessions(ENGLISH)).some((s) => s.id === 65536)).toBe(false)
  })

  it('leaves out session 0, which is services rather than a desktop', () => {
    expect(shadowable(parseSessions(ENGLISH)).some((s) => s.id === 0)).toBe(false)
  })

  it('keeps a translated active session', () => {
    expect(shadowable(parseSessions(RUSSIAN)).map((s) => s.id)).toEqual([1, 2])
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
