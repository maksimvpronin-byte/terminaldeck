import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROTOCOL,
  PROTOCOLS,
  isGraphical,
  protocolOf,
  traitsOf,
  type Protocol
} from './protocols'

describe('protocolOf', () => {
  it('treats a host saved before protocols existed as SSH', () => {
    // Every stored session predates the field, and every one of them is SSH.
    // Reading absent as anything else would silently repoint saved hosts.
    expect(protocolOf({})).toBe('ssh')
    expect(protocolOf(undefined)).toBe('ssh')
    expect(protocolOf(null)).toBe('ssh')
  })

  it('honours a stated protocol', () => {
    expect(protocolOf({ protocol: 'rdp' })).toBe('rdp')
  })

  it('falls back when the stored protocol is one this build does not know', () => {
    // `vnc` was briefly offered and then removed, so hosts saved with it exist
    // in the wild. Returning it verbatim would leave the pane dispatching on a
    // value nothing handles.
    expect(protocolOf({ protocol: 'vnc' as Protocol })).toBe('ssh')
  })
})

describe('traitsOf', () => {
  it('gives SSH the shell-bound panels', () => {
    const ssh = traitsOf('ssh')
    expect(ssh).toMatchObject({
      textual: true,
      files: true,
      tunnels: true,
      monitor: true,
      keyAuth: true,
      jumpHost: true
    })
  })

  it('withholds every shell-bound panel from a desktop', () => {
    // The point of the table: a toolbar must not offer SFTP or a monitoring
    // strip for a session that has no shell to run them over.
    const traits = traitsOf('rdp')
    expect(traits.textual).toBe(false)
    expect(traits.files).toBe(false)
    expect(traits.tunnels).toBe(false)
    expect(traits.monitor).toBe(false)
    expect(traits.broadcast).toBe(false)
    // A password, through CredSSP, and nothing else: no key file, no agent.
    expect(traits.keyAuth).toBe(false)
    // A desktop is reached through an RD Gateway, which is its own setting.
    expect(traits.jumpHost).toBe(false)
  })

  it('states the usual port for each', () => {
    expect(traitsOf('ssh').port).toBe(22)
    expect(traitsOf('rdp').port).toBe(3389)
  })

  it('falls back rather than returning undefined for an unknown protocol', () => {
    // A protocol read back from a file written by a newer version.
    const traits = traitsOf('telnet' as Protocol)
    expect(traits).toEqual(traitsOf(DEFAULT_PROTOCOL))
  })
})

describe('isGraphical', () => {
  it('separates desktops from shells', () => {
    expect(isGraphical('ssh')).toBe(false)
    expect(isGraphical('rdp')).toBe(true)
  })
})

describe('PROTOCOLS', () => {
  it('lists every protocol the traits table knows', () => {
    // Guards the pairing: a protocol added to one and not the other would
    // either vanish from the menu or crash the pane.
    for (const protocol of PROTOCOLS) expect(traitsOf(protocol).label).toBeTruthy()
    expect(PROTOCOLS).toContain(DEFAULT_PROTOCOL)
  })
})
