/** Remote Assistance RC_CTL channel names defined by MS-RA. */
export const REMOTE_ASSISTANCE_CHANNELS = {
  dynamicControl: 'RC_CTL',
  staticControl: 'remdesk',
  chat: '70',
  shareControl: '71'
} as const

export const REMOTE_ASSISTANCE_PROTOCOL_VERSIONS = {
  v1: 1,
  v2: 2,
  v3: 3
} as const

/** RC_CTL message types from the Remote Assistance protocol header. */
export const REMOTE_ASSISTANCE_MESSAGE_TYPES = {
  remoteControlDesktop: 1,
  result: 2,
  authenticate: 3,
  serverAnnounce: 4,
  disconnect: 5,
  versionInfo: 6,
  isConnected: 7,
  verifyPassword: 8,
  expertOnVista: 9,
  noviceName: 10,
  expertName: 11,
  token: 12
} as const

export const REMOTE_ASSISTANCE_RESULT = {
  noError: 0
} as const

/**
 * Boundary between the Remote Assistance state machine and an RDP client.
 * IronRDP 0.7.0 does not expose this capability yet; the native adapter can
 * implement it later without leaking transport details into the renderer.
 */
export interface RemoteAssistanceChannelTransport {
  open(name: string): Promise<void>
  send(data: Uint8Array): Promise<void>
  onData(callback: (data: Uint8Array) => void): () => void
  close(): Promise<void>
}

export type RemoteAssistanceProtocolState =
  | 'await-server-announce'
  | 'await-version-info'
  | 'await-novice-result'
  | 'ready-for-shadow'
  | 'failed'

/**
 * Minimal v2 expert-side handshake plan. This describes ordering only; the
 * bytes still have to be transported through an IronRDP virtual channel.
 */
export function nextRemoteAssistanceV2Messages(
  state: RemoteAssistanceProtocolState,
  messageType: number
): { state: RemoteAssistanceProtocolState; send: number[] } {
  const types = REMOTE_ASSISTANCE_MESSAGE_TYPES
  if (state === 'await-server-announce' && messageType === types.serverAnnounce) {
    return { state: 'await-version-info', send: [types.versionInfo] }
  }
  if (state === 'await-version-info' && messageType === types.versionInfo) {
    return { state: 'await-novice-result', send: [types.expertOnVista, types.verifyPassword] }
  }
  if (state === 'await-novice-result' && messageType === types.result) {
    return { state: 'ready-for-shadow', send: [] }
  }
  return { state: 'failed', send: [types.disconnect] }
}
