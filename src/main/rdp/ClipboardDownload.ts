import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

export interface ClipboardEntry {
  path: string
  directory: boolean
  size: number
}
const DESCRIPTOR_BYTES = 592
const CHUNK = 65536
const MAX_BYTES = 20 * 1024 ** 3

/** Validate the entire manifest before creating anything on disk. */
export function readFileDescriptors(data: Buffer): ClipboardEntry[] {
  if (data.length < 4) throw new Error('The server did not supply a file list')
  const count = data.readUInt32LE(0)
  if (!count || count > 10000 || data.length !== 4 + count * DESCRIPTOR_BYTES)
    throw new Error('Invalid RDP file list')
  const seen = new Map<string, boolean>()
  let total = 0
  const entries = Array.from({ length: count }, (_, i) => {
    const d = data.subarray(4 + i * DESCRIPTOR_BYTES, 4 + (i + 1) * DESCRIPTOR_BYTES)
    const raw = d.subarray(72).toString('utf16le')
    const end = raw.indexOf('\0')
    if (end < 0) throw new Error('Unterminated RDP file name')
    const path = raw.slice(0, end).replace(/\\/g, '/')
    const parts = path.split('/')
    if (
      parts.length > 64 ||
      parts.some(
        (p) =>
          !p ||
          p === '.' ||
          p === '..' ||
          /[<>:"|?*]/.test(p) ||
          Array.from(p).some((ch) => ch.charCodeAt(0) < 32) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)
      )
    ) {
      throw new Error('Unsafe RDP file name')
    }
    const attributes = d.readUInt32LE(36)
    if (attributes & 0x400) throw new Error('RDP links are not supported')
    const directory = Boolean(attributes & 0x10)
    if (!directory && !(d.readUInt32LE(0) & 0x40))
      throw new Error('The server did not supply the file size')
    const size = directory ? 0 : d.readUInt32LE(64) * 2 ** 32 + d.readUInt32LE(68)
    total += size
    if (!Number.isSafeInteger(size) || total > MAX_BYTES)
      throw new Error('Clipboard transfer exceeds 20 GB')
    const key = path.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error('Duplicate RDP file name')
    seen.set(key, directory)
    return { path, directory, size }
  })
  for (const entry of entries) {
    const parts = entry.path.normalize('NFC').toLowerCase().split('/')
    while (parts.pop() && parts.length) {
      if (seen.get(parts.join('/')) === false) throw new Error('A file is used as a directory')
    }
  }
  return entries
}

let nextStream = 1
const completedDirectories = new Set<string>()
export function cleanClipboardDownloads(): void {
  for (const dir of completedDirectories) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* An external application may still hold a file. */
    }
  }
  completedDirectories.clear()
}

type Request = { a: string; stream: number; index: number; offset: string; length: number }
/** One bounded request at a time, with a fresh stream id for every chunk. */
export class ClipboardDownload {
  private dir?: string
  private fd?: number
  private entries: ClipboardEntry[] = []
  private index = 0
  private offset = 0
  private received = 0
  private bytesTotal = 0
  get active(): boolean {
    return this.dir !== undefined
  }
  private stream = 0
  private requested = 0
  private timer?: NodeJS.Timeout
  constructor(
    private request: (request: Request) => void,
    private complete: (paths: string[]) => void,
    private status: (received: number, total: number, error?: string) => void
  ) {}

  start(manifest: Buffer): void {
    this.cancel()
    try {
      this.entries = readFileDescriptors(manifest)
      this.bytesTotal = this.entries.reduce((n, e) => n + e.size, 0)
      this.dir = mkdtempSync(join(tmpdir(), 'terminaldeck-rdp-files-'))
      this.index = this.offset = this.received = 0
      this.status(0, this.total())
      this.advance()
    } catch (e) {
      this.fail(e)
    }
  }
  private total(): number {
    return this.bytesTotal
  }
  private advance(): void {
    if (!this.dir) return
    while (this.index < this.entries.length) {
      const entry = this.entries[this.index]
      const path = join(this.dir, ...entry.path.split('/'))
      if (entry.directory) mkdirSync(path, { recursive: true, mode: 0o700 })
      else {
        if (this.fd === undefined) {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          this.fd = openSync(path, 'wx', 0o600)
        }
        if (this.offset < entry.size) {
          this.stream = nextStream++
          if (nextStream > 0x7fffffff) nextStream = 1
          this.requested = Math.min(CHUNK, entry.size - this.offset)
          this.timer = setTimeout(() => this.fail(new Error('RDP file transfer timed out')), 30000)
          this.request({
            a: 'clipget',
            stream: this.stream,
            index: this.index,
            offset: String(this.offset),
            length: this.requested
          })
          return
        }
        closeSync(this.fd)
        this.fd = undefined
      }
      this.index++
      this.offset = 0
    }
    const paths = [...new Set(this.entries.map((e) => e.path.split('/')[0]))].map((p) =>
      join(this.dir!, p)
    )
    completedDirectories.add(this.dir)
    this.dir = undefined
    this.status(this.received, this.total())
    this.complete(paths)
  }
  receive(packet: Buffer): void {
    if (!this.dir || packet.length < 8 || packet.readUInt32LE(0) !== this.stream) return
    clearTimeout(this.timer)
    try {
      const bytes = packet.subarray(8)
      if (
        packet.readUInt32LE(4) !== 1 ||
        !bytes.length ||
        bytes.length > this.requested ||
        this.fd === undefined
      ) {
        throw new Error('The RDP server refused or truncated the file transfer')
      }
      let written = 0
      while (written < bytes.length) {
        const n = writeSync(this.fd, bytes, written, bytes.length - written)
        if (!n) throw new Error('Could not write the received file')
        written += n
      }
      this.offset += bytes.length
      this.received += bytes.length
      this.status(this.received, this.total())
      this.advance()
    } catch (e) {
      this.fail(e)
    }
  }
  private fail(error: unknown): void {
    this.cancel()
    this.status(this.received, this.total(), error instanceof Error ? error.message : String(error))
  }
  cancel(): void {
    clearTimeout(this.timer)
    if (this.fd !== undefined) {
      closeSync(this.fd)
      this.fd = undefined
    }
    if (this.dir) {
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch {
        completedDirectories.add(this.dir)
      }
      this.dir = undefined
    }
    this.stream = 0
  }
}
