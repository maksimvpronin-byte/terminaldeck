import { describe, expect, it } from 'vitest'
import { parseRemoteAssistanceInvitation, selectRemoteAssistanceEndpoint } from './remoteAssistance'

const INVITATION = `<?xml version="1.0"?>
<UPLOADDATA USERNAME="jeff" RCTICKET="65538,1,192.168.1.65:3389;jeff_xp:3389,*,abc,*,*,def"
  RCTICKETENCRYPTED="1" PassStub="o2*5GdBARK_JBB" DtStart="2026-08-13T10:00:00Z" DtLength="60" />`

describe('parseRemoteAssistanceInvitation', () => {
  it('extracts the endpoint and invitation metadata', () => {
    expect(parseRemoteAssistanceInvitation(INVITATION)).toEqual({
      ticket: '65538,1,192.168.1.65:3389;jeff_xp:3389,*,abc,*,*,def',
      host: '192.168.1.65',
      port: 3389,
      username: 'jeff',
      passStub: 'o2*5GdBARK_JBB',
      encrypted: true,
      endpoints: [{ host: '192.168.1.65', port: 3389 }],
      startsAt: '2026-08-13T10:00:00Z',
      durationSeconds: 60
    })
  })

  it('parses the E/A/C/T/L invitation returned by Windows', () => {
    const xml =
      '<E><A ID="abc" KH="rawhash" KH2="sha256:hash" CE="cert&#xA;ificate"/><C><T ID="1" SID="0">' +
      '<L P="51824" N="fe80::1%5"/><L P="51825" N="10.10.10.9"/>' +
      '</T></C></E>'
    expect(parseRemoteAssistanceInvitation(xml)).toMatchObject({
      host: 'fe80::1%5',
      port: 51824,
      invitationId: 'abc',
      certificateDerBase64: 'certificate',
      keyHashBase64: 'hash',
      keyHashAlgorithm: 'sha256',
      endpoints: [
        { host: 'fe80::1%5', port: 51824 },
        { host: '10.10.10.9', port: 51825 }
      ]
    })
  })

  it('prefers a routable IPv4 listener', () => {
    const invitation = parseRemoteAssistanceInvitation(
      '<E><A/><C><T><L P="51824" N="fe80::1%5"/><L P="51825" N="10.10.10.9"/></T></C></E>'
    )
    expect(selectRemoteAssistanceEndpoint(invitation)).toEqual({ host: '10.10.10.9', port: 51825 })
  })

  it('supports namespaces, single quotes and XML entities', () => {
    const xml = `<ra:UPLOADDATA USERNAME='a&amp;b' RCTICKET='1,1,[2001:db8::1]:3390;x,*,a,*,*,b' />`
    expect(parseRemoteAssistanceInvitation(xml)).toMatchObject({
      username: 'a&b',
      host: '2001:db8::1',
      port: 3390,
      encrypted: false
    })
  })

  it.each([
    ['<UPLOADDATA />', 'no RCTICKET'],
    ['<ROOT />', 'no UPLOADDATA'],
    ['<UPLOADDATA RCTICKET="1,1,host" />', 'no RDP endpoint'],
    ['<UPLOADDATA RCTICKET="1,1,host:0;x" />', 'invalid RDP port']
  ])('rejects %s', (xml, message) => {
    expect(() => parseRemoteAssistanceInvitation(xml)).toThrow(message)
  })
})
