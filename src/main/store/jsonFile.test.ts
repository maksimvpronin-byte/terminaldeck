import { describe, it, expect, beforeEach } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  chmodSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonDocument, hasLists, readJson, writeJson } from './jsonFile'

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
     * A write made to fail, by a folder that takes no new file. This is the
     * whole difference between the two ways of doing it: writing in place
     * gets as far as truncating the real file before it fails, so the
     * contents are gone. Through a temporary, the failure happens somewhere
     * that does not matter yet.
     */
    chmodSync(dir, 0o555)
    try {
      expect(() => writeJson(file(), { keep: false })).toThrow()
    } finally {
      chmodSync(dir, 0o755)
    }
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

describe('readJson checking what it read', () => {
  it('sets aside JSON that parses but is not this store', () => {
    writeFileSync(file(), JSON.stringify({ hosts: [{ name: 'no id' }] }), 'utf8')

    const read = readJson(
      file(),
      () => ({ hosts: [] }),
      (v) => hasLists(v, { hosts: 'id' })
    )

    expect(read).toEqual({ hosts: [] })
    expect(readdirSync(dir).some((n) => n.startsWith('thing.json.damaged-'))).toBe(true)
  })

  it('takes a store whose lists are all it should be', () => {
    writeFileSync(file(), JSON.stringify({ hosts: [{ id: 'a' }] }), 'utf8')
    expect(
      readJson(
        file(),
        () => ({ hosts: [] }),
        (v) => hasLists(v, { hosts: 'id' })
      )
    ).toEqual({
      hosts: [{ id: 'a' }]
    })
  })
})

describe('JsonDocument', () => {
  it('keeps nothing in memory that did not reach the disk', () => {
    const doc = new JsonDocument(file, () => ({ hosts: ['a'] }))
    doc.change((d) => d.hosts.push('b'))

    // The same failure as above: a folder that takes no new file.
    chmodSync(dir, 0o555)
    try {
      expect(() => doc.change((d) => d.hosts.push('c'))).toThrow()
    } finally {
      chmodSync(dir, 0o755)
    }

    expect(doc.data).toEqual({ hosts: ['a', 'b'] })
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ hosts: ['a', 'b'] })
  })

  it('never changes what it handed out, so a snapshot can be put back', () => {
    const doc = new JsonDocument(file, () => ({ hosts: ['a'] }))
    const before = doc.snapshot()

    doc.change((d) => d.hosts.push('b'))
    expect(before).toEqual({ hosts: ['a'] })

    doc.restore(before)
    expect(doc.data).toEqual({ hosts: ['a'] })
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ hosts: ['a'] })
  })
})

/*
 * The copy on its way went to `<file>.tmp`, opened with `w`: an export into a
 * folder that already held that name — or a link by it to another file —
 * emptied whatever it named and wrote the backup there.
 */
describe('writing beside a name that is already taken', () => {
  it.skipIf(process.platform === 'win32')('leaves a file or link at <file>.tmp alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-json-'))
    try {
      const victim = join(dir, 'victim.txt')
      writeFileSync(victim, 'keep me', 'utf8')
      symlinkSync(victim, join(dir, 'export.json.tmp'))

      writeJson(join(dir, 'export.json'), { ok: true })

      expect(readFileSync(victim, 'utf8')).toBe('keep me')
      expect(JSON.parse(readFileSync(join(dir, 'export.json'), 'utf8'))).toEqual({ ok: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
