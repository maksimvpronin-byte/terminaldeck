import { describe, it, expect } from 'vitest'
import { parseSessions, shadowArgs, shadowable } from './winSessions'

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
