import { describe, expect, it } from 'vitest'
import {
  ERROR_CODE_ACCESS_DENIED,
  LOGON_FAILED_BAD_PASSWORD,
  LOGON_FAILED_OTHER,
  LOGON_FAILED_UPDATE_PASSWORD,
  LOGON_MSG_BUMP_OPTIONS,
  LOGON_MSG_DISCONNECT_REFUSED,
  LOGON_MSG_NO_PERMISSION,
  LOGON_MSG_RECONNECT_OPTIONS,
  LOGON_MSG_SESSION_BUSY_OPTIONS,
  LOGON_MSG_SESSION_CONTINUE,
  LOGON_MSG_SESSION_TERMINATE,
  isRefusal
} from './rdpLogon'

describe("the host's logon message", () => {
  // The one this module exists for. A session id in `data` — anything that is
  // not one of the three failure codes — with "the session continues" in
  // `type` is what a host sends when it puts you back into the session you
  // already had. It was closing the pane it was reporting on.
  it('is not a refusal when the host says the session continues', () => {
    expect(isRefusal(0x00030a1c, LOGON_MSG_SESSION_CONTINUE)).toBe(false)
  })

  it('is not a refusal when the host is offering options', () => {
    for (const type of [
      LOGON_MSG_BUMP_OPTIONS,
      LOGON_MSG_RECONNECT_OPTIONS,
      LOGON_MSG_SESSION_BUSY_OPTIONS
    ])
      expect(isRefusal(0x00030a1c, type)).toBe(false)
  })

  it('is not a refusal for a warning, which is a remark with a raised voice', () => {
    expect(isRefusal(0x00000003, LOGON_MSG_SESSION_CONTINUE)).toBe(false)
  })

  it('is a refusal when the logon itself failed', () => {
    for (const data of [
      LOGON_FAILED_BAD_PASSWORD,
      LOGON_FAILED_UPDATE_PASSWORD,
      LOGON_FAILED_OTHER
    ])
      expect(isRefusal(data, LOGON_MSG_SESSION_CONTINUE)).toBe(true)
  })

  it('is a refusal when the host says it will not have you', () => {
    for (const type of [
      LOGON_MSG_DISCONNECT_REFUSED,
      LOGON_MSG_NO_PERMISSION,
      LOGON_MSG_SESSION_TERMINATE,
      ERROR_CODE_ACCESS_DENIED
    ])
      expect(isRefusal(0x00030a1c, type)).toBe(true)
  })

  // These arrive as JSON from a separate process. A message that lost its codes
  // keeps the old behaviour, which is to believe the host over the generic
  // reason that follows.
  it('treats a message whose codes did not survive the trip as a refusal', () => {
    expect(isRefusal(undefined, undefined)).toBe(true)
    expect(isRefusal('0', LOGON_MSG_SESSION_CONTINUE)).toBe(true)
    expect(isRefusal(0x00030a1c, null)).toBe(true)
    expect(isRefusal(1.5, LOGON_MSG_SESSION_CONTINUE)).toBe(true)
    expect(isRefusal(Number.NaN, LOGON_MSG_SESSION_CONTINUE)).toBe(true)
  })
})
