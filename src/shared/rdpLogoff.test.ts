import { describe, expect, it } from 'vitest'
import {
  endedBySignOut,
  ERRINFO_LOGOFF_BY_USER,
  ERRINFO_RPC_INITIATED_LOGOFF,
  logoffSequence,
  SENT_WAIT,
  type LogoffStep
} from './rdpLogoff'

const sent = (steps: LogoffStep[]): Record<string, unknown>[] =>
  steps.flatMap((s) => ('send' in s ? [s.send] : []))

describe('signing out of a Windows desktop', () => {
  it('opens Run with the Windows key and R, releasing both', () => {
    const keys = sent(logoffSequence()).filter((f) => f.a === 'key')
    expect(keys.slice(0, 4)).toEqual([
      { a: 'key', code: 0x5b, down: true, ext: true },
      { a: 'key', code: 0x13, down: true, ext: false },
      { a: 'key', code: 0x13, down: false, ext: false },
      { a: 'key', code: 0x5b, down: false, ext: true }
    ])
  })

  it('types the command as Unicode, so the far layout cannot change it', () => {
    const typed = sent(logoffSequence())
      .filter((f) => f.a === 'unicode' && f.down)
      .map((f) => String.fromCharCode(f.code as number))
      .join('')
    expect(typed).toBe('logoff')
  })

  it('waits for the dialog before typing, and presses Enter after', () => {
    const steps = logoffSequence()
    const firstWait = steps.findIndex((s) => 'wait' in s)
    const firstChar = steps.findIndex((s) => 'send' in s && s.send.a === 'unicode')
    const enter = steps.findIndex((s) => 'send' in s && s.send.a === 'key' && s.send.code === 0x1c)
    expect(firstWait).toBeLessThan(firstChar)
    expect(enter).toBeGreaterThan(firstChar)
  })

  it('ends on a wait, so the keys have gone before the pane stops the client', () => {
    expect(logoffSequence().at(-1)).toEqual({ wait: SENT_WAIT })
  })

  it('leaves nothing held down', () => {
    const held = new Set<string>()
    for (const f of sent(logoffSequence())) {
      if (f.a !== 'key' && f.a !== 'unicode') continue
      const id = `${f.a}:${f.code}`
      if (f.down) held.add(id)
      else held.delete(id)
    }
    expect([...held]).toEqual([])
  })
})

describe('a desktop that ended', () => {
  it('was signed out of when the host says the user logged off', () => {
    expect(endedBySignOut(ERRINFO_LOGOFF_BY_USER, 0x0001000c)).toBe(true)
  })

  it('was signed out of when it was logged off from elsewhere', () => {
    expect(endedBySignOut(ERRINFO_RPC_INITIATED_LOGOFF, 0)).toBe(true)
  })

  // The last error is overwritten by whatever fails as the transport comes
  // down; the host's own reason is what decides.
  it('believes the host over a last error that was overwritten', () => {
    expect(endedBySignOut(ERRINFO_LOGOFF_BY_USER, 0x00020009)).toBe(true)
  })

  it('was not signed out of when it was disconnected, timed out or dropped', () => {
    expect(endedBySignOut(0x00000001, 0x00010001)).toBe(false) // disconnected by an admin
    expect(endedBySignOut(0x0000000b, 0x0001000b)).toBe(false) // Start, Disconnect
    expect(endedBySignOut(0x00000003, 0x00010003)).toBe(false) // idle timeout
    expect(endedBySignOut(0, 0x00020009)).toBe(false) // the network went
  })

  it('reads the last error when a client too old to send the reason sent none', () => {
    expect(endedBySignOut(undefined, 0x0001000c)).toBe(true)
    expect(endedBySignOut(undefined, 0x0002000c)).toBe(false)
    expect(endedBySignOut(undefined, undefined)).toBe(false)
  })
})
