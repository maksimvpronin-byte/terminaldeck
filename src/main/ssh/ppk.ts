import { createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { argon2dAsync, argon2iAsync, argon2idAsync } from '@noble/hashes/argon2.js'

/**
 * PuTTY's key files, turned into OpenSSH's on the way to ssh2.
 *
 * ssh2 reads PPK itself, but only version 2 and only RSA and DSA keys. PuTTYgen
 * has written version 3 by default since 0.75, and ECDSA and Ed25519 keys in
 * every version, so most .ppk files people actually have were refused with
 * "Unsupported key format". The conversion happens in memory at connect time;
 * the file on disk is never touched.
 *
 * Electron's crypto has no Argon2 — it is built on BoringSSL — so the key
 * derivation of an encrypted version 3 file comes from @noble/hashes, in its
 * asynchronous form: it takes a second or so, and the main process should not
 * stand still for it.
 */

const PPK_HEADER = /^PuTTY-User-Key-File-(\d+): *(\S+)\s*$/

export function isPpk(data: Buffer): boolean {
  return data.subarray(0, 20).toString('latin1') === 'PuTTY-User-Key-File-'
}

/** Why a PPK file was refused, worded for the connection error it becomes. */
export class PpkError extends Error {}

interface PpkFile {
  version: number
  algorithm: string
  fields: Map<string, string>
}

function parseFile(text: string): PpkFile {
  const lines = text.split(/\r?\n/)
  const header = PPK_HEADER.exec(lines[0] ?? '')
  if (!header) throw new PpkError('Not a PuTTY key file')
  const version = Number(header[1])
  if (version !== 2 && version !== 3) {
    throw new PpkError(`PuTTY key file version ${version} is not supported`)
  }
  const fields = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const match = /^([A-Za-z0-9-]+): *(.*?)\s*$/.exec(lines[i])
    if (!match) continue
    const [, name, value] = match
    if (name.endsWith('-Lines')) {
      // "Public-Lines: 6" is followed by six lines of base64 making up "Public".
      const count = Number(value)
      fields.set(name.slice(0, -'-Lines'.length), lines.slice(i + 1, i + 1 + count).join(''))
      i += count
    } else {
      fields.set(name, value)
    }
  }
  return { version, algorithm: header[2], fields }
}

function field(file: PpkFile, name: string): string {
  const value = file.fields.get(name)
  if (value === undefined) throw new PpkError(`PuTTY key file has no ${name} field`)
  return value
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

/** An SSH wire-format string: a length, then the bytes. */
function sshString(data: Buffer | string): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return Buffer.concat([uint32(bytes.length), bytes])
}

/** Reads SSH wire-format strings (mpints included) off a blob, in order. */
function reader(blob: Buffer): () => Buffer {
  let at = 0
  return () => {
    if (at + 4 > blob.length) throw new PpkError('PuTTY key file is truncated')
    const len = blob.readUInt32BE(at)
    if (at + 4 + len > blob.length) throw new PpkError('PuTTY key file is truncated')
    const out = blob.subarray(at + 4, at + 4 + len)
    at += 4 + len
    return out
  }
}

interface Keys {
  cipherKey: Buffer
  iv: Buffer
  macKey: Buffer
  hmac: 'sha1' | 'sha256'
}

function v2Keys(passphrase: string): Keys {
  const pass = Buffer.from(passphrase, 'utf8')
  const sha1 = (...parts: Buffer[]): Buffer =>
    createHash('sha1').update(Buffer.concat(parts)).digest()
  return {
    cipherKey: Buffer.concat([sha1(uint32(0), pass), sha1(uint32(1), pass)]).subarray(0, 32),
    iv: Buffer.alloc(16),
    macKey: sha1(Buffer.from('putty-private-key-file-mac-key'), pass),
    hmac: 'sha1'
  }
}

const ARGON2 = { Argon2id: argon2idAsync, Argon2i: argon2iAsync, Argon2d: argon2dAsync } as const

async function v3Keys(file: PpkFile, passphrase: string | undefined): Promise<Keys> {
  if (passphrase === undefined) {
    // Unencrypted: the MAC is still there, keyed with nothing.
    return {
      cipherKey: Buffer.alloc(0),
      iv: Buffer.alloc(0),
      macKey: Buffer.alloc(0),
      hmac: 'sha256'
    }
  }
  const kdf = ARGON2[field(file, 'Key-Derivation') as keyof typeof ARGON2]
  if (!kdf) throw new PpkError(`Unknown key derivation ${field(file, 'Key-Derivation')}`)
  const out = Buffer.from(
    await kdf(Buffer.from(passphrase, 'utf8'), Buffer.from(field(file, 'Argon2-Salt'), 'hex'), {
      t: Number(field(file, 'Argon2-Passes')),
      m: Number(field(file, 'Argon2-Memory')),
      p: Number(field(file, 'Argon2-Parallelism')),
      dkLen: 80
    })
  )
  return {
    cipherKey: out.subarray(0, 32),
    iv: out.subarray(32, 48),
    macKey: out.subarray(48, 80),
    hmac: 'sha256'
  }
}

/**
 * The private key laid out as OpenSSH lays it out, from PuTTY's two blobs.
 * Numbers are carried over as they are: both formats write them as SSH mpints.
 */
function openSshFields(algorithm: string, publicBlob: Buffer, privateBlob: Buffer): Buffer[] {
  const pub = reader(publicBlob)
  const priv = reader(privateBlob)
  if (pub().toString('latin1') !== algorithm) {
    throw new PpkError('PuTTY key file names one algorithm and holds another')
  }
  if (algorithm === 'ssh-rsa') {
    const [e, n] = [pub(), pub()]
    const [d, p, q, iqmp] = [priv(), priv(), priv(), priv()]
    return [n, e, d, iqmp, p, q]
  }
  if (algorithm === 'ssh-dss') {
    return [pub(), pub(), pub(), pub(), priv()]
  }
  if (algorithm.startsWith('ecdsa-sha2-')) {
    return [pub(), pub(), priv()]
  }
  if (algorithm === 'ssh-ed25519') {
    // PuTTY keeps the 32-byte seed; OpenSSH keeps the seed and the public key.
    const publicKey = pub()
    return [publicKey, Buffer.concat([priv(), publicKey])]
  }
  throw new PpkError(`PuTTY keys of type ${algorithm} are not supported`)
}

function toOpenSsh(
  algorithm: string,
  comment: string,
  publicBlob: Buffer,
  fields: Buffer[]
): string {
  const check = randomBytes(4)
  const body = Buffer.concat([
    check,
    check,
    sshString(algorithm),
    ...fields.map(sshString),
    sshString(comment)
  ])
  const padLength = (8 - (body.length % 8)) % 8
  const padding = Buffer.from(Array.from({ length: padLength }, (_, i) => i + 1))
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicBlob),
    sshString(Buffer.concat([body, padding]))
  ])
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? []
  return [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    ...lines,
    '-----END OPENSSH PRIVATE KEY-----',
    ''
  ].join('\n')
}

/**
 * A PuTTY key file as an unencrypted OpenSSH private key, for ssh2.
 *
 * The passphrase is only consulted when the file is encrypted, and the result
 * never carries one: it exists only in memory, for the one connection.
 */
export async function ppkToOpenSsh(text: string, passphrase?: string): Promise<string> {
  const file = parseFile(text)
  const encryption = field(file, 'Encryption')
  if (encryption !== 'none' && encryption !== 'aes256-cbc') {
    throw new PpkError(`PuTTY key file encryption ${encryption} is not supported`)
  }
  const encrypted = encryption === 'aes256-cbc'
  if (encrypted && !passphrase) {
    throw new PpkError('Encrypted PuTTY key file, but no passphrase given')
  }
  const pass = encrypted ? passphrase : undefined
  const keys = file.version === 2 ? v2Keys(pass ?? '') : await v3Keys(file, pass)

  const comment = file.fields.get('Comment') ?? ''
  const publicBlob = Buffer.from(field(file, 'Public'), 'base64')
  let privateBlob = Buffer.from(field(file, 'Private'), 'base64')
  if (encrypted) {
    if (privateBlob.length % 16 !== 0) throw new PpkError('PuTTY key file is truncated')
    const decipher = createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv).setAutoPadding(false)
    privateBlob = Buffer.concat([decipher.update(privateBlob), decipher.final()])
  }

  const mac = createHmac(keys.hmac, keys.macKey)
    .update(
      Buffer.concat([
        sshString(file.algorithm),
        sshString(encryption),
        sshString(comment),
        sshString(publicBlob),
        sshString(privateBlob)
      ])
    )
    .digest()
  const expected = Buffer.from(field(file, 'Private-MAC'), 'hex')
  if (expected.length !== mac.length || !timingSafeEqual(mac, expected)) {
    throw new PpkError(
      encrypted
        ? 'Wrong passphrase for the PuTTY key file'
        : 'PuTTY key file is corrupt (MAC mismatch)'
    )
  }

  return toOpenSsh(
    file.algorithm,
    comment,
    publicBlob,
    openSshFields(file.algorithm, publicBlob, privateBlob)
  )
}

/**
 * A key file as ssh2 wants it: a PuTTY one converted, anything else as it is.
 * The passphrase goes along only when ssh2 still has something to decrypt.
 */
export async function readPrivateKey(
  path: string,
  passphrase: string | undefined
): Promise<{ privateKey: Buffer | string; passphrase?: string }> {
  const data = readFileSync(path)
  if (!isPpk(data)) return { privateKey: data, passphrase }
  return { privateKey: await ppkToOpenSsh(data.toString('utf8'), passphrase) }
}
