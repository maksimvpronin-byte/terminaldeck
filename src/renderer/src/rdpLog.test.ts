/* eslint-disable no-console -- The console is the thing under test. */
import { describe, it, expect, afterEach } from 'vitest'
import { captureClientLog, type ClientLogCapture } from './rdpLog'

/** Restored after each test, or a failure would leave the console swallowed. */
let running: ClientLogCapture | null = null
afterEach(() => {
  running?.stop()
  running = null
})

describe('catching the desktop client’s log', () => {
  it('keeps what was logged, saying which level it came from', () => {
    running = captureClientLog(10)

    console.info('Connect to RDP host')
    console.warn('receiver is closed')

    expect(running.lines()).toEqual(['[info] Connect to RDP host', '[warn] receiver is closed'])
  })

  it('joins several arguments into the one line', () => {
    running = captureClientLog(10)

    console.debug('codec', 42, { name: 'gfx' })

    expect(running.lines()).toEqual(['[debug] codec 42 {"name":"gfx"}'])
  })

  it('survives something that refuses to be stringified', () => {
    running = captureClientLog(10)
    const circular: Record<string, unknown> = {}
    circular.self = circular

    console.log(circular)

    expect(running.lines()).toHaveLength(1)
  })

  /**
   * The whole point: a live desktop logs several lines per frame, and holding
   * them is what took the renderer to four gigabytes.
   */
  it('stops at the limit and keeps nothing after it', () => {
    running = captureClientLog(3)

    for (let i = 0; i < 100; i++) console.info(`line ${i}`)

    expect(running.lines()).toEqual(['[info] line 0', '[info] line 1', '[info] line 2'])
  })

  it('hands over what it caught the moment it is full, once', () => {
    const handed: string[][] = []
    running = captureClientLog(2, (lines) => handed.push([...lines]))

    for (let i = 0; i < 50; i++) console.info(`line ${i}`)

    expect(handed).toHaveLength(1)
    expect(handed[0]).toEqual(['[info] line 0', '[info] line 1'])
  })

  it('gives the console back, so nothing is swallowed afterwards', () => {
    const before = console.info
    const capture = captureClientLog(2)

    expect(console.info).not.toBe(before)
    capture.stop()

    expect(console.info).toBe(before)
  })

  it('gives it back at the limit without being asked', () => {
    const before = console.info
    running = captureClientLog(1)

    console.info('the only one')

    expect(console.info).toBe(before)
  })
})
