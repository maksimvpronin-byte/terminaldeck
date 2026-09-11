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
    expect(requests[0]).toMatchObject({ index: 1, offset: '0', length: 65536 })
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
