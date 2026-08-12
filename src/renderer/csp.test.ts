import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The window's Content-Security-Policy, guarded directive by directive.
 *
 * Every allowance here was added for one reason, and each was found the hard
 * way: without them the RDP client fails with `Failed to fetch`, or a bare
 * refusal to compile, neither of which points at a policy. Tightening this
 * policy is a reasonable instinct, so the test states what would break.
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

  it('allows WebAssembly to compile', () => {
    // Chromium refuses to compile a module under a CSP without this, and the
    // RDP client is a WebAssembly module.
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'")
  })

  it('does not hand back eval for JavaScript along with it', () => {
    // 'unsafe-eval' would cover wasm too, and far more besides.
    expect(csp).not.toContain("'unsafe-eval'")
  })

  it('allows the wasm to be fetched from a data URL', () => {
    // The RDP client embeds its module as data:application/wasm and loads it
    // by fetching that URL, which connect-src governs.
    expect(directive('connect-src')).toContain('data:')
  })

  it('allows the client to reach the gateway on loopback', () => {
    // The client opens its own WebSocket to the gateway main runs, on a port
    // the operating system picks.
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

  it('allows a remote cursor to arrive as a data image', () => {
    expect(directive('img-src')).toContain('data:')
  })
})
