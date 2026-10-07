import { describe, expect, it } from 'vitest'
import { complaintIn, failureText, isEcho } from './clientLog'

/** A line in WinPR's default layout, which is what the client actually writes. */
function logged(level: string, fn: string, message: string): string {
  return `[13:04:51:120] [4812:4816] [${level}][com.freerdp.core.nego] - [${fn}]: ${message}`
}

describe('complaintIn', () => {
  it('keeps the message and drops the prefix', () => {
    expect(
      complaintIn(
        logged(
          'ERROR',
          'nego_connect',
          'Protocol Security Negotiation Failure: SSL_NOT_ALLOWED_BY_SERVER [0x00000002]'
        )
      )
    ).toBe('Protocol Security Negotiation Failure: SSL_NOT_ALLOWED_BY_SERVER [0x00000002]')
  })

  it('ignores the levels a working session narrates itself at', () => {
    expect(complaintIn(logged('DEBUG', 'nego_connect', 'state: NEGO_STATE_NLA'))).toBeUndefined()
    expect(complaintIn(logged('INFO', 'nego_connect', 'Negotiated NLA security'))).toBeUndefined()
    expect(complaintIn('')).toBeUndefined()
  })

  it('takes a warning as well, which is sometimes the only word there is', () => {
    expect(
      complaintIn(logged('WARN', 'transport_read_layer', 'BIO_read returned a system error'))
    ).toBe('BIO_read returned a system error')
  })

  it('reads a line that carries no function name', () => {
    expect(
      complaintIn(
        '[13:04:51:120] [4812:4816] [ERROR][com.freerdp.core] - No security protocol is enabled'
      )
    ).toBe('No security protocol is enabled')
  })

  it('cuts a line that would fill the pane', () => {
    const long = complaintIn(logged('ERROR', 'nego_connect', 'x'.repeat(400)))
    expect(long).toHaveLength(201)
    expect(long?.endsWith('…')).toBe(true)
  })
})

describe('failureText', () => {
  it('says the step, the reason and the code', () => {
    expect(
      failureText(
        'The connection failed at negotiating security settings.',
        'Protocol Security Negotiation Failure',
        0x00020009
      )
    ).toBe(
      'The connection failed at negotiating security settings. — Protocol Security Negotiation Failure (0x00020009)'
    )
  })

  it('does not say the same thing twice', () => {
    expect(failureText('Logon failed.', 'Logon failed.', 0)).toBe('Logon failed.')
  })

  it('stands on its own when the client said nothing', () => {
    expect(failureText('', undefined, 0)).toBe('Could not connect')
    expect(failureText('   ', undefined, 0x0002000d)).toBe('Could not connect (0x0002000d)')
  })
})

/** What a failing channel says on its way out, after it has said why. */
describe('isEcho', () => {
  it.each([
    'checkChannelErrorEvent() failed - 0',
    'cliprdr_virtual_channel_open_event_ex reported an error. Error was 12',
    'failed with error 12',
    'Stream_New failed!',
    'transport_check_fds: transport->ReceiveCallback() - STATE_RUN_FAILED [-1]'
  ])('takes %s for an echo', (line) => {
    expect(isEcho(line)).toBe(true)
  })

  it('takes the reason for the reason', () => {
    expect(
      isEcho(
        'clipboard channel: a continuation arrived with no message open (flags 0x00000010, size 1600, total 1048588, 0 of the open message so far)'
      )
    ).toBe(false)
    expect(isEcho('No security protocol is enabled')).toBe(false)
  })
})
