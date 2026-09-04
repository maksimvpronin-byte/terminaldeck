import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { removeTree } from './removeTree'

describe('removeTree', () => {
  it('takes a checkout with read-only files in it', () => {
    // What a git checkout looks like: everything under objects/ is written once
    // and marked read-only, which on Windows is a file that cannot be unlinked
    // until the attribute is cleared.
    const root = mkdtempSync(join(tmpdir(), 'terminaldeck-rm-'))
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    const object = join(root, '.git', 'objects', 'ab12cd')
    writeFileSync(object, 'contents', 'utf8')
    chmodSync(object, 0o444)

    removeTree(root)

    expect(existsSync(root)).toBe(false)
  })

  it('says nothing about a directory that is not there', () => {
    expect(() => removeTree(join(tmpdir(), 'terminaldeck-not-a-directory'))).not.toThrow()
  })

  it('never throws, whatever it is given', () => {
    // Housekeeping that fails must not reach the caller: this ran after a
    // successful clone, and its failure was what the user saw instead of the
    // inventory they had asked for.
    const file = join(mkdtempSync(join(tmpdir(), 'terminaldeck-rm-')), 'a-file')
    writeFileSync(file, '', 'utf8')
    expect(() => removeTree(join(file, 'inside-a-file'))).not.toThrow()
  })
})
