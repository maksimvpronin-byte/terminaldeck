import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ClipboardDownload,
  cleanClipboardDownloads,
  readFileDescriptors
} from './ClipboardDownload'

function manifest(items: Array<{ name: string; size?: number; dir?: boolean }>): Buffer {
  const data = Buffer.alloc(4 + items.length * 592)
  data.writeUInt32LE(items.length)
  items.forEach((item, i) => {
    const offset = 4 + i * 592
    data.writeUInt32LE(0x44, offset)
    data.writeUInt32LE(item.dir ? 0x10 : 0x80, offset + 36)
    data.writeUInt32LE(item.size ?? 0, offset + 68)
    data.write(item.name, offset + 72, 518, 'utf16le')
  })
  return data
}
function packet(stream: number, data: Buffer, ok = true): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(stream)
  head.writeUInt32LE(ok ? 1 : 2, 4)
  return Buffer.concat([head, data])
}
afterEach(() => {
  cleanClipboardDownloads()
  vi.useRealTimers()
})

describe('RDP file clipboard', () => {
  it('receives nested folders, Unicode names, empty files and multiple chunks without buffering the entire file', () => {
    const requests: Array<{ stream: number; index: number; offset: string; length: number }> = []
    let paths: string[] = []
    const status = vi.fn()
    const download = new ClipboardDownload(
      (r) => requests.push(r),
      (p) => {
        paths = p
      },
      status
    )
    const body = Buffer.alloc(70000, 0xa7)
    download.start(
      manifest([
        { name: 'Папка', dir: true },
        { name: 'Папка\\текст.bin', size: body.length },
        { name: 'empty.txt' }
      ])
    )
    expect(paths).toEqual([])
    expect(requests[0]).toMatchObject({ index: 1, offset: '0', length: 70000 })
    // A short answer is written, and the rest asked for from where it ended.
    download.receive(packet(requests[0].stream, body.subarray(0, 65536)))
    expect(requests[1]).toMatchObject({ index: 1, offset: '65536', length: 4464 })
    // A duplicate or stale chunk cannot overwrite the next range.
    download.receive(packet(requests[0].stream, body.subarray(0, 65536)))
    expect(paths).toEqual([])
    download.receive(packet(requests[1].stream, body.subarray(65536)))
    expect(readFileSync(join(paths[0], 'текст.bin'))).toEqual(body)
    expect(readFileSync(paths[1])).toHaveLength(0)
    expect(status).toHaveBeenLastCalledWith(70000, 70000)
  })
  /**
   * Several requests out at once had a Windows host answer them on several
   * threads, the pieces of the answers interleaved on the channel, and FreeRDP
   * ended the session. One is out at a time, and each asks for a mebibyte.
   */
  describe('a file larger than one chunk', () => {
    type Req = { stream: number; index: number; offset: string; length: number }
    const MiB = 1024 * 1024
    const body = Buffer.alloc(2 * MiB + 100)
    for (let i = 0; i < body.length; i++) body[i] = i % 251
    function begin(): { requests: Req[]; paths: () => string[]; status: ReturnType<typeof vi.fn> } {
      const requests: Req[] = []
      let paths: string[] = []
      const status = vi.fn()
      const download = new ClipboardDownload(
        (r) => requests.push(r),
        (p) => {
          paths = p
        },
        status
      )
      download.start(manifest([{ name: 'big.bin', size: body.length }]))
      answer = (r: Req, bytes = Number(r.length), ok = true): void =>
        download.receive(
          packet(r.stream, body.subarray(Number(r.offset), Number(r.offset) + bytes), ok)
        )
      return { requests, paths: () => paths, status }
    }
    let answer: (r: Req, bytes?: number, ok?: boolean) => void = () => undefined

    it('asks for one mebibyte at a time, and the next only once the last has come', () => {
      const { requests, paths } = begin()
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ offset: '0', length: MiB })
      answer(requests[0])
      expect(requests).toHaveLength(2)
      expect(requests[1]).toMatchObject({ offset: String(MiB), length: MiB })
      answer(requests[1])
      expect(requests[2]).toMatchObject({ offset: String(2 * MiB), length: 100 })
      answer(requests[2])
      expect(readFileSync(paths()[0]).equals(body)).toBe(true)
    })

    it('drops to 64 KiB chunks when the server refuses a mebibyte', () => {
      const { requests, paths, status } = begin()
      answer(requests[0], 0, false)
      expect(requests[1]).toMatchObject({ offset: '0', length: 65536 })
      while (!paths().length) answer(requests.at(-1)!)
      expect(readFileSync(paths()[0]).equals(body)).toBe(true)
      expect(status.mock.calls.some((c) => c[2])).toBe(false)
    })

    it('drops to 64 KiB chunks on a stall, and fails only when those stall too', () => {
      vi.useFakeTimers()
      const { requests, status } = begin()
      vi.advanceTimersByTime(30000)
      expect(requests).toHaveLength(2)
      expect(requests[1]).toMatchObject({ offset: '0', length: 65536 })
      expect(status.mock.lastCall?.[2]).toBeUndefined()
      vi.advanceTimersByTime(30000)
      expect(status.mock.lastCall?.[2]).toMatch(/timed out/)
    })
  })

  it.each([
    '..\\escape',
    '/absolute',
    'C:\\escape',
    'folder\\..\\escape',
    'name:stream',
    'CON.txt',
    'folder\\',
    'trailing.'
  ])('refuses unsafe path %s', (name) => {
    expect(() => readFileDescriptors(manifest([{ name }]))).toThrow('Unsafe')
  })
  it('rejects duplicate names and paths under files before creating any files', () => {
    expect(() => readFileDescriptors(manifest([{ name: 'A' }, { name: 'a' }]))).toThrow('Duplicate')
    expect(() => readFileDescriptors(manifest([{ name: 'a' }, { name: 'a\\b' }]))).toThrow(
      'directory'
    )
    expect(() => readFileDescriptors(Buffer.alloc(3))).toThrow()
  })
  it.each(['failure', 'timeout', 'cancel'])('cleans an incomplete download on %s', (how) => {
    vi.useFakeTimers()
    const before = new Set(readdirSync(tmpdir()))
    let stream = 0
    const complete = vi.fn(),
      status = vi.fn()
    const download = new ClipboardDownload(
      (r) => {
        stream = r.stream
      },
      complete,
      status
    )
    download.start(manifest([{ name: 'data', size: 100 }]))
    const created = readdirSync(tmpdir()).filter(
      (n) => n.startsWith('terminaldeck-rdp-files-') && !before.has(n)
    )
    expect(created).toHaveLength(1)
    if (how === 'failure') download.receive(packet(stream, Buffer.alloc(0), false))
    if (how === 'timeout') vi.advanceTimersByTime(30000)
    if (how === 'cancel') download.cancel()
    expect(existsSync(join(tmpdir(), created[0]))).toBe(false)
    expect(complete).not.toHaveBeenCalled()
    if (how !== 'cancel') expect(status.mock.lastCall?.[2]).toBeTruthy()
  })
})

it('reports a failed retry from the timeout callback and cancels the download', () => {
  vi.useFakeTimers()
  let failed = false
  const status = vi.fn()
  const download = new ClipboardDownload(
    () => {
      if (failed) throw new Error('Client disconnected')
    },
    vi.fn(),
    status
  )
  download.start(manifest([{ name: 'retry.bin', size: 200000 }]))
  failed = true
  expect(() => vi.advanceTimersByTime(30000)).not.toThrow()
  expect(download.active).toBe(false)
  expect(status).toHaveBeenLastCalledWith(0, 200000, 'Client disconnected')
})

/**
 * A host whose policy keeps its files in answers every request for one with
 * an empty message. The transfer ended a minute later on a timeout; it ends
 * at once, saying why.
 */
it('ends at once, saying so, when the host refuses to hand the file over', () => {
  vi.useFakeTimers()
  const requests: unknown[] = []
  const status = vi.fn()
  const download = new ClipboardDownload((r) => requests.push(r), vi.fn(), status)
  download.start(manifest([{ name: 'kept.json', size: 66845 }]))
  download.refuse()
  expect(download.active).toBe(false)
  expect(status.mock.lastCall?.[2]).toMatch(/refused to hand over/)
  vi.advanceTimersByTime(60000)
  expect(requests).toHaveLength(1)
})
