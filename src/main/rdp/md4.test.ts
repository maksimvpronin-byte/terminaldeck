import { describe, it, expect } from 'vitest'
import { md4 } from './md4'

const hex = (input: string): string =>
  Buffer.from(md4(new TextEncoder().encode(input))).toString('hex')

describe('md4', () => {
  // RFC 1320, appendix A.5. Every one of these has to match exactly: NTLM
  // derives its key from this hash, and a wrong digest is indistinguishable
  // from a wrong password once it reaches a gateway.
  it('matches the RFC test suite', () => {
    expect(hex('')).toBe('31d6cfe0d16ae931b73c59d7e0c089c0')
    expect(hex('a')).toBe('bde52cb31de33e46245e05fbdbd6fb24')
    expect(hex('abc')).toBe('a448017aaf21d8525fc10ae87aa6729d')
    expect(hex('message digest')).toBe('d9130a8164549fe818874806e1c7014b')
    expect(hex('abcdefghijklmnopqrstuvwxyz')).toBe('d79e1c308aa5bbcdeea8ed63df412da9')
    expect(hex('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      '043f8582f241db351ce627e153e7f0e4'
    )
    // Eight repetitions, 80 bytes — two blocks, and the padding lands in the
    // second one with no room to spare.
    expect(hex('1234567890'.repeat(8))).toBe('e33b4ddc9c38f2199c3e7b164fcc0536')
  })

  it('handles a message that lands exactly on a block boundary', () => {
    // 56 bytes is the length at which the padding needs a whole extra block.
    expect(hex('a'.repeat(56))).toHaveLength(32)
    expect(hex('a'.repeat(64))).toHaveLength(32)
  })

  it('is the NTLM password hash', () => {
    // MS-NLMP 4.2.4.1.1: NTOWFv2 starts from MD4 of the UTF-16LE password.
    const password = Buffer.from('Password', 'utf16le')
    expect(Buffer.from(md4(password)).toString('hex')).toBe('a4f49c406510bdcab6824ee7c30fd852')
  })
})
