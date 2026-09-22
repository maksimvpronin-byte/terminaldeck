import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A rename refused for a moment. On Windows a scanner or the search indexer
 * opens a file that has just been written, and a rename onto it answers EPERM
 * until it lets go. Its own file, because `fs` has to be stood in for.
 */
const refusals = { left: 0, code: 'EPERM' }

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    renameSync: (from: string, to: string): void => {
      if (refusals.left > 0) {
        refusals.left--
        throw Object.assign(new Error(`${refusals.code}: rename refused`), {
          code: refusals.code
        })
      }
      actual.renameSync(from, to)
    }
  }
})

const { writeJson } = await import('./jsonFile')

let dir = ''
const file = (): string => join(dir, 'thing.json')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'terminaldeck-json-retry-'))
  refusals.left = 0
  refusals.code = 'EPERM'
})

describe('writeJson when the rename is refused', () => {
  it('tries again while a scanner holds the file, and then writes', () => {
    refusals.left = 2
    writeJson(file(), { saved: true })
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ saved: true })
  })

  it('gives up on a refusal that does not pass, and leaves no temporary file', () => {
    writeJson(file(), { saved: 'before' })
    refusals.left = 100
    expect(() => writeJson(file(), { saved: 'after' })).toThrow(/EPERM/)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ saved: 'before' })
    expect(existsSync(`${file()}.tmp`)).toBe(false)
  })

  it('does not wait on a failure that is not a scanner', () => {
    refusals.left = 1
    refusals.code = 'ENOSPC'
    expect(() => writeJson(file(), { saved: true })).toThrow(/ENOSPC/)
    expect(refusals.left).toBe(0)
  })
})
