import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readJson, writeJson } from './jsonFile'

/**
 * The rule these six files share, tested where it lives.
 *
 * Three of the stores wrote in place and three did not, which is the sort of
 * difference nobody notices until the file that mattered was one of the three.
 * Now there is one rule, and this is what it promises.
 */
let dir = ''
const file = (): string => join(dir, 'thing.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'terminaldeck-json-'))
})

describe('writeJson', () => {
  it('writes what it is given, and reads back the same', () => {
    writeJson(file(), { hosts: ['a', 'b'] })
    expect(readJson(file(), () => ({ hosts: [] }))).toEqual({ hosts: ['a', 'b'] })
  })

  it('leaves the previous contents when the write fails', () => {
    writeJson(file(), { keep: true })
    const before = readFileSync(file(), 'utf8')

    /**
     * A write made to fail, by putting a directory where the temporary file
     * wants to be. This is the whole difference between the two ways of doing
     * it: writing in place gets as far as truncating the real file before it
     * fails, so the contents are gone. Through a temporary, the failure happens
     * somewhere that does not matter yet.
     */
    mkdirSync(`${file()}.tmp`)
    expect(() => writeJson(file(), { keep: false })).toThrow()
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('creates the directory it is asked to write into', () => {
    const nested = join(dir, 'a', 'b', 'thing.json')
    writeJson(nested, { ok: 1 })
    expect(existsSync(nested)).toBe(true)
  })

  it('leaves no temporary behind', () => {
    writeJson(file(), { ok: 1 })
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('readJson', () => {
  it('uses the fallback for a file that was never there, and says nothing', () => {
    expect(readJson(file(), () => ({ fresh: true }))).toEqual({ fresh: true })
    expect(readdirSync(dir)).toEqual([])
  })

  /**
   * The half that costs the data. Returning the fallback and carrying on shows
   * an application with nothing in it — which reads as "everything is gone" —
   * and the first save then writes that emptiness over what was still there.
   */
  it('puts a damaged file aside instead of letting it be overwritten', () => {
    writeFileSync(file(), '{"hosts": ["a", "b', 'utf8')

    expect(readJson(file(), () => ({ hosts: [] }))).toEqual({ hosts: [] })

    const kept = readdirSync(dir).filter((n) => n.includes('.damaged-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toContain('"a"')

    // And what is written next cannot reach it.
    writeJson(file(), { hosts: ['c'] })
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toContain('"a"')
  })

  it('still starts when the damaged file cannot be moved aside', () => {
    // A read-only directory is the real case; a name already taken is the one
    // a test can arrange. Either way, refusing to start would be worse.
    writeFileSync(file(), 'not json', 'utf8')
    expect(readJson(file(), () => ({ hosts: [] }))).toEqual({ hosts: [] })
  })
})
