/**
 * MD4, because NTLM cannot be computed without it and Node no longer offers it.
 *
 * OpenSSL 3 moved MD4 into the legacy provider, so `createHash('md4')` throws
 * `error:0308010C:digital envelope routines::unsupported` on any modern build —
 * including the one Electron ships. Enabling the legacy provider to get one hash
 * back would turn every deprecated cipher on with it, so the hash is done here
 * instead. RFC 1320 in about sixty lines.
 *
 * Nothing else in this app should use it. MD4 is broken for every purpose it was
 * designed for; it survives here only because NTLM's key derivation is defined
 * in terms of it and the far end will accept nothing else.
 */
export function md4(message: Uint8Array): Uint8Array {
  const padded = pad(message)
  const words = new Int32Array(padded.length / 4)
  for (let i = 0; i < words.length; i++) {
    words[i] =
      padded[i * 4] | (padded[i * 4 + 1] << 8) | (padded[i * 4 + 2] << 16) | (padded[i * 4 + 3] << 24)
  }

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  for (let offset = 0; offset < words.length; offset += 16) {
    const [aa, bb, cc, dd] = [a, b, c, d]
    const x = (i: number): number => words[offset + i]

    // Round 1: F(x,y,z) = (x & y) | (~x & z), added to the block word.
    for (const [i, shift] of ROUND_1) {
      const value = a + ((b & c) | (~b & d)) + x(i)
      ;[a, b, c, d] = [d, rotate(value, shift), b, c]
    }
    // Round 2: G(x,y,z) = majority, with the round's own constant.
    for (const [i, shift] of ROUND_2) {
      const value = a + ((b & c) | (b & d) | (c & d)) + x(i) + 0x5a827999
      ;[a, b, c, d] = [d, rotate(value, shift), b, c]
    }
    // Round 3: H(x,y,z) = x ^ y ^ z.
    for (const [i, shift] of ROUND_3) {
      const value = a + (b ^ c ^ d) + x(i) + 0x6ed9eba1
      ;[a, b, c, d] = [d, rotate(value, shift), b, c]
    }

    a = (a + aa) | 0
    b = (b + bb) | 0
    c = (c + cc) | 0
    d = (d + dd) | 0
  }

  const digest = new Uint8Array(16)
  const view = new DataView(digest.buffer)
  view.setInt32(0, a, true)
  view.setInt32(4, b, true)
  view.setInt32(8, c, true)
  view.setInt32(12, d, true)
  return digest
}

/**
 * The rounds as (word index, rotation) pairs. Written out rather than computed:
 * the orders are irregular by design, and a loop that derived them would be
 * harder to check against the RFC than the table it came from.
 */
const ROUND_1: Array<[number, number]> = [
  [0, 3], [1, 7], [2, 11], [3, 19], [4, 3], [5, 7], [6, 11], [7, 19],
  [8, 3], [9, 7], [10, 11], [11, 19], [12, 3], [13, 7], [14, 11], [15, 19]
]
const ROUND_2: Array<[number, number]> = [
  [0, 3], [4, 5], [8, 9], [12, 13], [1, 3], [5, 5], [9, 9], [13, 13],
  [2, 3], [6, 5], [10, 9], [14, 13], [3, 3], [7, 5], [11, 9], [15, 13]
]
const ROUND_3: Array<[number, number]> = [
  [0, 3], [8, 9], [4, 11], [12, 15], [2, 3], [10, 9], [6, 11], [14, 15],
  [1, 3], [9, 9], [5, 11], [13, 15], [3, 3], [11, 9], [7, 11], [15, 15]
]

function rotate(value: number, by: number): number {
  return (value << by) | (value >>> (32 - by))
}

/** The message, a 0x80 byte, zeroes, and the bit length as 64 little-endian bits. */
function pad(message: Uint8Array): Uint8Array {
  const length = message.length
  // At least one byte of padding, and the total must leave room for the length.
  const total = (((length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(total)
  padded.set(message)
  padded[length] = 0x80

  const bits = BigInt(length) * 8n
  const view = new DataView(padded.buffer)
  view.setUint32(total - 8, Number(bits & 0xffffffffn), true)
  view.setUint32(total - 4, Number((bits >> 32n) & 0xffffffffn), true)
  return padded
}
