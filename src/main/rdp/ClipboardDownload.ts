import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

export interface ClipboardEntry {
  path: string
  directory: boolean
  size: number
}
const DESCRIPTOR_BYTES = 592
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
 * How much one request asks for.
 *
 * One request is out at a time, and that is not a choice this file is free to
 * revisit. Several out at once let the far end answer them on several threads,
 * and the pieces of one answer then arrive between the pieces of another. The
 * channel has one reassembly buffer and no way to tell two answers apart, so
 * FreeRDP drops the session with "Stream_New failed!", which the pane showed as
 * "Success.". Speed comes from size instead: a mebibyte per round trip is about
 * 20 MiB/s at 50 ms, and a single answer, however long, arrives in order.
 */
const CHUNK = 1024 * 1024
/** What a server that refuses or stalls on the large size is asked for instead. */
const SMALL_CHUNK = 65536

/** The chunk asked for. */
interface Pending {
  stream: number
  offset: number
  length: number
}

/**
 * Fetches the files a desktop copied, one chunk at a time, with a fresh stream
 * id for every chunk and each file written in order.
 *
 * A server that will not serve a mebibyte at once is not given up on: a
 * refusal or a stall drops this transfer to 64 KiB chunks and asks again from
 * the last byte written.
 */
export class ClipboardDownload {
  private dir?: string
  private fd?: number
  private entries: ClipboardEntry[] = []
  private index = 0
  /** Bytes of the current file on disk, which is also where the next request starts. */
  private written = 0
  private pending?: Pending
  private chunk = CHUNK
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
      this.index = this.written = this.received = 0
      this.chunk = CHUNK
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
          if (!this.pending) this.ask(entry.size)
          return
        }
        closeSync(this.fd)
        this.fd = undefined
      }
      this.index++
      this.written = 0
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
  /** Asks for the next chunk of the current file, and gives the transfer another 30 s. */
  private ask(size: number): void {
    const slot = {
      stream: nextStream++,
      offset: this.written,
      length: Math.min(this.chunk, size - this.written)
    }
    if (nextStream > 0x7fffffff) nextStream = 1
    this.pending = slot
    this.request({
      a: 'clipget',
      stream: slot.stream,
      index: this.index,
      offset: String(slot.offset),
      length: slot.length
    })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.stalled(), 30000)
  }
  receive(packet: Buffer): void {
    if (!this.dir || packet.length < 8) return
    const stream = packet.readUInt32LE(0)
    // An answer to anything but the request out — a duplicate, or one given up
    // on — cannot land in the range that follows.
    const slot = this.pending
    if (!slot || slot.stream !== stream) return
    try {
      const bytes = packet.subarray(8)
      if (
        packet.readUInt32LE(4) !== 1 ||
        !bytes.length ||
        bytes.length > slot.length ||
        this.fd === undefined
      ) {
        return this.shrink(new Error('The RDP server refused or truncated the file transfer'))
      }
      this.pending = undefined
      let written = 0
      while (written < bytes.length) {
        const n = writeSync(this.fd, bytes, written, bytes.length - written)
        if (!n) throw new Error('Could not write the received file')
        written += n
      }
      // A short answer is not an error: the next request starts where it ended.
      this.written += bytes.length
      this.received += bytes.length
      this.status(this.received, this.total())
      this.advance()
    } catch (e) {
      this.fail(e)
    }
  }
  /**
   * Down to 64 KiB chunks, from the last byte written — or, if the request
   * that failed was no larger than that already, the end of the transfer.
   */
  private shrink(error: Error): void {
    if (!this.pending || this.pending.length <= SMALL_CHUNK) return this.fail(error)
    this.chunk = SMALL_CHUNK
    this.pending = undefined
    this.advance()
  }
  /**
   * The host said no to the request out, which some do to every request for a
   * file's contents: a policy that lets a file be announced on the clipboard
   * and never handed over. Neither a smaller chunk nor another wait changes
   * that answer, so the transfer ends here.
   */
  refuse(): void {
    if (!this.dir) return
    this.fail(
      new Error(
        'The remote desktop refused to hand over the file; its policy may forbid copying files out'
      )
    )
  }
  private stalled(): void {
    try {
      this.shrink(new Error('RDP file transfer timed out'))
    } catch (error) {
      this.fail(error)
    }
  }
  private fail(error: unknown): void {
    this.cancel()
    this.status(this.received, this.total(), error instanceof Error ? error.message : String(error))
  }
  cancel(): void {
    clearTimeout(this.timer)
    this.pending = undefined
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
