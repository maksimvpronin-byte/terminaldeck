import { describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearReadOnly, removeTree } from './removeTree'

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

/**
 * A link inside a checkout is the checkout's; what it points at is not. The
 * read-only attribute was cleared by statting through links, which reached
 * files outside the tree and went round a link that pointed back up it.
 */
describe('clearing read-only inside a checkout', () => {
  /** A directory link — a junction on Windows, which needs no privilege to make. */
  function linkDir(target: string, path: string): void {
    symlinkSync(target, path, 'junction')
  }
  const readOnly = (path: string): boolean => (statSync(path).mode & 0o222) === 0

  it('does not reach files a link points at outside the tree', () => {
    const outside = mkdtempSync(join(tmpdir(), 'terminaldeck-outside-'))
    const precious = join(outside, 'precious.txt')
    writeFileSync(precious, 'not the checkout’s', 'utf8')
    chmodSync(precious, 0o444)
    const root = mkdtempSync(join(tmpdir(), 'terminaldeck-rm-'))
    linkDir(outside, join(root, 'link'))

    clearReadOnly(root)
    expect(readOnly(precious)).toBe(true)

    removeTree(root)
    expect(existsSync(root)).toBe(false)
    expect(readFileSync(precious, 'utf8')).toBe('not the checkout’s')
    expect(readOnly(precious)).toBe(true)

    chmodSync(precious, 0o666)
    rmSync(outside, { recursive: true, force: true })
  })

  it('does not go round a link that points back up the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'terminaldeck-rm-'))
    mkdirSync(join(root, 'a'))
    const file = join(root, 'a', 'object')
    writeFileSync(file, 'x', 'utf8')
    chmodSync(file, 0o444)
    linkDir(root, join(root, 'a', 'loop'))

    expect(() => clearReadOnly(root)).not.toThrow()
    expect(readOnly(file)).toBe(false)

    removeTree(root)
    expect(existsSync(root)).toBe(false)
  })
})
