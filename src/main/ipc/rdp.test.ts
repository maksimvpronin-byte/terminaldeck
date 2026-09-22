import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (): string => '/tmp', isPackaged: false },
  clipboard: {},
  ipcMain: { on: () => undefined, handle: () => undefined }
}))

const { isWindowCommand } = await import('./rdp')

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
})
