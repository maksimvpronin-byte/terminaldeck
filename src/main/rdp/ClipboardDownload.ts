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

/**
 * How many chunk requests may be out at once.
 *
 * One at a time, every chunk cost a full round trip before the next was even
 * asked for: 64 KiB per 50 ms is about 1.25 MiB/s however fast the link. Eight
 * keep half a megabyte in flight, which is also all this ever holds in memory
 * for a transfer — an answer that arrives ahead of its turn waits here until
 * the ones before it are written.
 */
const WINDOW = 8

/** One chunk asked for, and its answer once it has come and is waiting its turn. */
interface Pending {
  stream: number
  offset: number
  length: number
  data?: Buffer
}

/**
 * Fetches the files a desktop copied, a bounded window of chunks at a time,
 * with a fresh stream id for every chunk and each file written strictly in
 * order.
 *
 * A server that will not answer more than one request at a time is not given
 * up on: a refusal or a stall while several are out drops this transfer to one
 * request at a time, which is how it always worked, and asks again from the
 * last byte written.
 */
export class ClipboardDownload {
  private dir?: string
  private fd?: number
  private entries: ClipboardEntry[] = []
  private index = 0
  /** Bytes of the current file on disk. */
  private written = 0
  /** Where the next request for the current file starts. */
  private asked = 0
  private pending: Pending[] = []
  private window = WINDOW
  private received = 0
  private bytesTotal = 0
  get active(): boolean {
    return this.dir !== undefined
  }
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
      this.index = this.written = this.asked = this.received = 0
      this.window = WINDOW
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
        if (this.written < entry.size) {
          this.ask(entry.size)
          return
        }
        closeSync(this.fd)
        this.fd = undefined
      }
      this.index++
      this.written = this.asked = 0
    }
    clearTimeout(this.timer)
    const paths = [...new Set(this.entries.map((e) => e.path.split('/')[0]))].map((p) =>
      join(this.dir!, p)
    )
    completedDirectories.add(this.dir)
    this.dir = undefined
    this.status(this.received, this.total())
    this.complete(paths)
  }
  /** Tops the window up for the current file, and gives the transfer another 30 s. */
  private ask(size: number): void {
    while (this.pending.length < this.window && this.asked < size) {
      const slot = {
        stream: nextStream++,
        offset: this.asked,
        length: Math.min(CHUNK, size - this.asked)
      }
      if (nextStream > 0x7fffffff) nextStream = 1
      this.pending.push(slot)
      this.asked += slot.length
      this.request({
        a: 'clipget',
        stream: slot.stream,
        index: this.index,
        offset: String(slot.offset),
        length: slot.length
      })
    }
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.stalled(), 30000)
  }
  receive(packet: Buffer): void {
    if (!this.dir || packet.length < 8) return
    const stream = packet.readUInt32LE(0)
    // An answer to nothing still out — a duplicate, or one dropped with the
    // window — cannot land in the range that follows.
    const slot = this.pending.find((p) => p.stream === stream && !p.data)
    if (!slot) return
    try {
      const bytes = packet.subarray(8)
      if (
        packet.readUInt32LE(4) !== 1 ||
        !bytes.length ||
        bytes.length > slot.length ||
        this.fd === undefined
      ) {
        if (this.pending.length > 1) return this.narrow()
        throw new Error('The RDP server refused or truncated the file transfer')
      }
      // Copied: the record it arrived in is not ours to keep.
      slot.data = Buffer.from(bytes)
      this.flush()
    } catch (e) {
      this.fail(e)
    }
  }
  /**
   * Writes every answer that is next in line, then asks for more.
   *
   * Synchronous writes, still: one is a 64 KiB copy into the page cache, and
   * the requests already out keep the link busy while it happens.
   */
  private flush(): void {
    while (this.pending[0]?.data) {
      const { data, length } = this.pending.shift()!
      let written = 0
      while (written < data!.length) {
        const n = writeSync(this.fd!, data!, written, data!.length - written)
        if (!n) throw new Error('Could not write the received file')
        written += n
      }
      this.written += data!.length
      this.received += data!.length
      if (data!.length < length) {
        // A short answer leaves a gap no later request covers. Those are
        // dropped, and the rest is asked for again from here.
        this.pending = []
        this.asked = this.written
      }
    }
    this.status(this.received, this.total())
    this.advance()
  }
  /** Back to one request at a time, from the last byte written. */
  private narrow(): void {
    this.window = 1
    this.pending = []
    this.asked = this.written
    this.advance()
  }
  private stalled(): void {
    if (this.pending.length > 1) this.narrow()
    else this.fail(new Error('RDP file transfer timed out'))
  }
  private fail(error: unknown): void {
    this.cancel()
    this.status(this.received, this.total(), error instanceof Error ? error.message : String(error))
  }
  cancel(): void {
    clearTimeout(this.timer)
    this.pending = []
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
  }
}
