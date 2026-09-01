import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The window's Content-Security-Policy, guarded directive by directive.
 *
 * It used to be the other way round: three allowances existed for a client that
 * ran as WebAssembly in this window, each found the hard way, and this file
 * stated what would break if they were tightened. That client is gone — the
 * desktop is drawn by a program of its own now — so what is worth guarding is
 * that they do not come back by habit.
 */
const csp = ((): string => {
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8')
  const match = html.match(/http-equiv="Content-Security-Policy"\s*content="([^"]+)"/)
  if (!match) throw new Error('The window has no Content-Security-Policy')
  return match[1]
})()

const directive = (name: string): string => {
  const found = csp.split(';').find((part) => part.trim().startsWith(name))
  return found ? found.trim() : ''
}

describe('the window CSP', () => {
  it('still has a policy at all, and still defaults to self', () => {
    expect(directive('default-src')).toBe("default-src 'self'")
  })

  it('does not let the window compile WebAssembly', () => {
    // Nothing in the renderer is a WebAssembly module any more. The allowance
    // that let one compile was the price of the client that has been replaced,
    // and it should not survive it.
    expect(directive('script-src')).toBe("script-src 'self'")
  })

  it('hands back no form of eval', () => {
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toContain("'wasm-unsafe-eval'")
  })

  it('does not let the window fetch a data URL', () => {
    // This existed to load an embedded wasm module. An image may still be a
    // data URL — see below — but nothing may be fetched as one.
    expect(directive('connect-src')).not.toContain('data:')
  })

  it('allows the dev server’s hot reload, and only on loopback', () => {
    // Development only: a packaged window opens no socket of its own.
    expect(directive('connect-src')).toContain('ws://127.0.0.1:*')
  })

  it('does not allow the window to reach anything off this machine', () => {
    const connect = directive('connect-src')
    // A wildcard host, or plain ws:/wss: without a host, would let the window
    // talk to the network directly — which is the main process's job here.
    expect(connect).not.toMatch(/\s\*/)
    expect(connect).not.toMatch(/ws:\/\/\*/)
    expect(connect).not.toMatch(/wss:\/\//)
    expect(connect).not.toMatch(/https?:\/\//)
  })

  it('allows a remote pointer to be drawn as a data image', () => {
    // The far end sends its pointer as pixels; a canvas turns those into the
    // data: URL that CSS takes as a cursor.
    expect(directive('img-src')).toContain('data:')
  })
})
