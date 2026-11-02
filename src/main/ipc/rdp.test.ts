import { describe, it, expect, vi } from 'vitest'
import type { SessionProfile } from '../../shared/types'
import { AUTH_FALLBACK } from '../../shared/authResolution'

vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp', isPackaged: false },
  clipboard: {},
  ipcMain: { on: () => undefined, handle: () => undefined }
}))

const { isWindowCommand, desktopGateway } = await import('./rdp')
const { vault } = await import('../vault/Vault')

describe('RD Gateway credentials', () => {
  const profile = (rdp: object): SessionProfile => ({
    id: 'desktop',
    name: 'desktop',
    host: 'host',
    groupId: null,
    tags: [],
    logToFile: false,
    portForwards: [],
    createdAt: 0,
    updatedAt: 0,
    gatewayHost: 'gateway',
    ...rdp
  })
  const auth = { ...AUTH_FALLBACK, username: 'CORP\\desktop' }

  it.each(['   ', 'CORP\\'])('refuses an explicit gateway login with no account: %s', (name) => {
    expect(() => desktopGateway(profile({ gatewayUsername: name }), [], auth)).toThrow(
      /Gateway username/
    )
  })

  it('uses the host login with the gateway password when only a password is configured', () => {
    const read = vi.spyOn(vault, 'getSecret').mockReturnValueOnce('gateway-password')
    try {
      expect(desktopGateway(profile({ gatewaySecretRef: 'gw-ref' }), [], auth)).toMatchObject({
        username: 'desktop',
        domain: 'CORP',
        password: 'gateway-password'
      })
    } finally {
      read.mockRestore()
    }
  })

  it('leaves credentials shared only when no gateway login or password is configured', () => {
    expect(desktopGateway(profile({}), [], auth)).toMatchObject({
      username: undefined,
      password: undefined
    })
  })
})

/**
 * The window drives a desktop's input. The same pipe also carries what only
 * the main process may decide — which certificate to trust, which local files
 * to offer the far end — and the window could send those too.
 */
describe('what the window may tell a desktop client', () => {
  it('passes input, sizes and acknowledgements', () => {
    expect(isWindowCommand({ a: 'key', code: 30, down: true, ext: false })).toBe(true)
    expect(isWindowCommand({ a: 'xmouse', flags: 1, x: 2, y: 3 })).toBe(true)
    expect(isWindowCommand({ a: 'resize', width: 1280, height: 800, scale: undefined })).toBe(true)
    expect(isWindowCommand({ a: 'ack' })).toBe(true)
  })

  it('refuses what is the main process to decide', () => {
    expect(isWindowCommand({ a: 'cert', trust: true })).toBe(false)
    expect(isWindowCommand({ a: 'clipset', text: '', uris: 'file:///etc/passwd' })).toBe(false)
    expect(isWindowCommand({ a: 'clipget', stream: 1, index: 0 })).toBe(false)
    expect(isWindowCommand({ a: 'start', host: 'x' })).toBe(false)
  })

  it('refuses anything that is not a flat command', () => {
    expect(isWindowCommand(null)).toBe(false)
    expect(isWindowCommand('key')).toBe(false)
    expect(isWindowCommand([{ a: 'key' }])).toBe(false)
    expect(isWindowCommand({ a: 'key', code: { nested: true } })).toBe(false)
  })

  /**
   * A field name with a line break in it ended the allowed command and began
   * another: an `ack` carrying `cert trust=1` past the certificate dialog.
   */
  it('refuses fields a command does not read', () => {
    expect(isWindowCommand({ a: 'ack', 'x\n\na\tcert\ntrust': 1 })).toBe(false)
    expect(isWindowCommand({ a: 'ack', trust: 1 })).toBe(false)
    expect(isWindowCommand({ a: 'mouse', flags: 1, x: 2, y: 3, uris: 'file:///' })).toBe(false)
    expect(isWindowCommand({ a: 'key', code: 'text', down: true })).toBe(false)
    expect(isWindowCommand({ a: 'constructor' })).toBe(false)
  })
})
