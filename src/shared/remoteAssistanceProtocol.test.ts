import { describe, expect, it } from 'vitest'
import {
  REMOTE_ASSISTANCE_CHANNELS,
  REMOTE_ASSISTANCE_MESSAGE_TYPES,
  nextRemoteAssistanceV2Messages
} from './remoteAssistanceProtocol'

describe('Remote Assistance RC_CTL protocol', () => {
  it('uses the Windows channel names', () => {
    expect(REMOTE_ASSISTANCE_CHANNELS).toEqual({
      dynamicControl: 'RC_CTL',
      staticControl: 'remdesk',
      chat: '70',
      shareControl: '71'
    })
  })

  it('describes the v2 expert handshake ordering', () => {
    const types = REMOTE_ASSISTANCE_MESSAGE_TYPES
    expect(nextRemoteAssistanceV2Messages('await-server-announce', types.serverAnnounce)).toEqual({
      state: 'await-version-info',
      send: [types.versionInfo]
    })
    expect(nextRemoteAssistanceV2Messages('await-version-info', types.versionInfo)).toEqual({
      state: 'await-novice-result',
      send: [types.expertOnVista, types.verifyPassword]
    })
    expect(nextRemoteAssistanceV2Messages('await-novice-result', types.result)).toEqual({
      state: 'ready-for-shadow',
      send: []
    })
  })

  it('disconnects on an unexpected message', () => {
    const result = nextRemoteAssistanceV2Messages('await-version-info', REMOTE_ASSISTANCE_MESSAGE_TYPES.token)
    expect(result).toEqual({ state: 'failed', send: [REMOTE_ASSISTANCE_MESSAGE_TYPES.disconnect] })
  })

  it('keeps transport concerns behind a small channel boundary', () => {
    const transport: import('./remoteAssistanceProtocol').RemoteAssistanceChannelTransport = {
      open: async () => undefined,
      send: async () => undefined,
      onData: () => () => undefined,
      close: async () => undefined
    }
    expect(transport).toBeDefined()
  })
})
