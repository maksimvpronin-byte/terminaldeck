import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SessionProfile } from '../../shared/types'

/**
 * The store reads `app.getPath` in its constructor, so the module is pulled in
 * dynamically — after the temporary directory exists and the mock can answer.
 */
let userData = ''
vi.mock('electron', () => ({ app: { getPath: (): string => userData } }))

const FILE = (): string => join(userData, 'sessions.json')

/**
 * A store that has just read the directory this test made.
 *
 * The module exports one instance built at import time, so the module registry
 * is reset first: without that, every test after the first would be talking to
 * the store that read the first test's directory.
 */
async function freshStore(): Promise<{ save: (s: SessionProfile) => void; count: () => number }> {
  vi.resetModules()
  const { sessionStore } = await import('./SessionStore')
  return {
    save: (s) => void sessionStore.saveSession(s),
    count: () => sessionStore.getAll().sessions.length
  }
}

const host = (id: string): SessionProfile =>
  ({ id, name: id, host: '10.0.0.1', groupId: null }) as SessionProfile

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'terminaldeck-sessions-'))
})

describe('the session store', () => {
  it('keeps what it is given', async () => {
    const store = await freshStore()
    store.save(host('a'))
    expect(JSON.parse(readFileSync(FILE(), 'utf8')).sessions).toHaveLength(1)
  })

  /**
   * Written through a temporary file and a rename, the way the vault and the
   * collection store already were. Writing in place leaves a truncated file the
   * moment anything interrupts it — and this is the file holding every host,
   * group and setting, rewritten on each edit and each drag.
   */
  it('leaves the tree intact when the write itself fails', async () => {
    const store = await freshStore()
    store.save(host('a'))
    const before = readFileSync(FILE(), 'utf8')

    /**
     * A write made to fail, by putting a directory where the temporary file
     * wants to be. This is the whole difference between the two ways of doing
     * it: writing in place would have got as far as truncating the real file
     * before failing, and the tree would be gone. Through a temporary, the
     * failure happens somewhere that does not matter yet.
     */
    mkdirSync(`${FILE()}.tmp`)
    expect(() => store.save(host('b'))).toThrow()
    expect(readFileSync(FILE(), 'utf8')).toBe(before)
  })

  /**
   * A damaged file is not silently replaced by an empty tree.
   *
   * That is the obvious behaviour and the one that loses the data: the window
   * shows no hosts, which reads as "my sessions are gone", and the first save
   * after that writes the empty tree over the file that still held them.
   */
  it('puts a damaged file aside instead of overwriting it', async () => {
    writeFileSync(FILE(), '{"sessions": [{"id": "a", "na', 'utf8')

    const store = await freshStore()
    expect(store.count()).toBe(0)

    // The original is still there under a name of its own…
    const kept = readdirSync(userData).filter((n) => n.includes('.damaged-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(userData, kept[0]), 'utf8')).toContain('"id": "a"')

    // …and the save that follows cannot reach it.
    store.save(host('b'))
    expect(existsSync(FILE())).toBe(true)
    expect(readFileSync(join(userData, kept[0]), 'utf8')).toContain('"id": "a"')
  })
})
