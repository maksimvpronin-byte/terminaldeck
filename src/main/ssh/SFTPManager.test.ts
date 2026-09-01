import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import type { SFTPWrapper } from 'ssh2'
import type { TransferDecisions, TransferItem, TransferPlan } from '../../shared/types'

/**
 * `buildTransferPlan` decides what a transfer would trample and is tested in
 * shared/transferPlan.test.ts. This is the other half — the one that actually
 * writes — and it is exercised against a stub SFTP session rather than a host.
 *
 * The stub is put straight into the manager's session map, so nothing here
 * reaches SSHManager. Electron is still mocked because the module graph behind
 * it reads `app.getPath` when the stores are constructed.
 */
let userData = ''
vi.mock('electron', () => ({
  // Named imports fail outright if a module in the graph asks for something
  // this object does not have, so everything SSHManager, authPrompt,
  // hostVerifier and KnownHosts import by name is present, whether or not a
  // stub session ever reaches it.
  app: { getPath: (): string => userData },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: () => undefined, once: () => undefined, removeListener: () => undefined },
  dialog: { showMessageBox: async () => ({ response: 0 }) }
}))

userData = mkdtempSync(join(tmpdir(), 'terminaldeck-sftp-'))
const { sftpManager } = await import('./SFTPManager')

const localDir = mkdtempSync(join(tmpdir(), 'terminaldeck-sftp-local-'))

/** One recorded call on a stub session: what was asked for, and of what. */
interface Call {
  op: 'fastPut' | 'fastGet' | 'mkdir' | 'read' | 'write'
  path: string
  to?: string
}

interface Entry {
  size?: number
  dir?: boolean
}

/**
 * A stand-in for one host's SFTP session. `entries` is what it claims to
 * already hold; everything else is reported missing, which is what makes the
 * manager create the parent directories. Anything written to it lands in
 * `received`, keyed by path.
 */
function stubSession(
  calls: Call[],
  entries: Record<string, Entry> = {},
  opts: { failReadOpen?: boolean; received?: Record<string, string> } = {}
): SFTPWrapper {
  const session = {
    fastPut(
      local: string,
      remote: string,
      transfer: { step?: (t: number, chunk: number, total: number) => void },
      cb: (err?: Error | null) => void
    ): void {
      calls.push({ op: 'fastPut', path: local, to: remote })
      transfer.step?.(512, 512, 1024)
      cb(null)
    },
    fastGet(
      remote: string,
      local: string,
      transfer: { step?: (t: number, chunk: number, total: number) => void },
      cb: (err?: Error | null) => void
    ): void {
      calls.push({ op: 'fastGet', path: remote, to: local })
      transfer.step?.(512, 512, 1024)
      // The real one creates the file. The stub has to as well, or it cannot
      // say anything about what happens to it afterwards.
      writeFileSync(local, 'fetched', 'utf8')
      cb(null)
    },
    mkdir(path: string, cb: (err?: Error | null) => void): void {
      calls.push({ op: 'mkdir', path })
      entries[path] = { dir: true }
      cb(null)
    },
    lstat(
      path: string,
      cb: (err: (Error & { code?: number }) | null, stats?: unknown) => void
    ): void {
      const entry = entries[path]
      if (!entry) {
        cb(Object.assign(new Error('No such file'), { code: 2 }))
        return
      }
      cb(null, {
        isDirectory: () => entry.dir === true,
        isSymbolicLink: () => false,
        size: entry.size ?? 0,
        mtime: 0,
        mode: 0o644,
        uid: 0,
        gid: 0
      })
    },
    createReadStream(path: string): PassThrough {
      calls.push({ op: 'read', path })
      const stream = new PassThrough()
      if (opts.failReadOpen) {
        setImmediate(() => stream.destroy(new Error('Permission denied')))
      } else {
        // `relay` waits for 'open' before it touches the destination, and only
        // then attaches the pipe — so the bytes must come after the event, not
        // with it.
        setImmediate(() => {
          stream.emit('open')
          stream.end('the file')
        })
      }
      return stream
    },
    /**
     * A Writable, deliberately, and not another PassThrough: `relay` resolves on
     * the destination's 'close', and a Duplex only destroys itself once both of
     * its sides are done. Nothing reads the far side of a PassThrough here, so
     * one would finish, never close, and hang the transfer.
     */
    createWriteStream(path: string): Writable {
      calls.push({ op: 'write', path })
      const chunks: Buffer[] = []
      return new Writable({
        write(chunk: Buffer, _encoding, cb: (err?: Error | null) => void): void {
          chunks.push(chunk)
          cb()
        },
        final(cb: (err?: Error | null) => void): void {
          if (opts.received) opts.received[path] = Buffer.concat(chunks).toString('utf8')
          cb()
        }
      })
    }
  }
  return session as unknown as SFTPWrapper
}

/** The manager caches one session per connection; a test supplies its own. */
function attach(connectionId: string, session: SFTPWrapper): void {
  ;(sftpManager as unknown as { sessions: Map<string, SFTPWrapper> }).sessions.set(
    connectionId,
    session
  )
}

function item(sourcePath: string, destPath: string): TransferItem {
  return { sourcePath, destPath, sourceSize: 1024, sourceMtime: 0 }
}

function plan(direction: TransferPlan['direction'], items: TransferItem[]): TransferPlan {
  return {
    direction,
    items,
    conflicts: [],
    collisions: [],
    totalBytes: items.reduce((sum, i) => sum + i.sourceSize, 0)
  }
}

beforeEach(() => {
  ;(sftpManager as unknown as { sessions: Map<string, SFTPWrapper> }).sessions.clear()
  rmSync(localDir, { recursive: true, force: true })
})

describe('running a transfer plan', () => {
  it('uploads every item and says how many it wrote', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv': { dir: true } }))

    const result = await sftpManager.runPlan(
      'conn',
      plan('upload', [item('/local/a.txt', '/srv/a.txt'), item('/local/b.txt', '/srv/b.txt')])
    )

    expect(result).toEqual({ written: 2, skipped: 0 })
    expect(calls.filter((c) => c.op === 'fastPut')).toEqual([
      { op: 'fastPut', path: '/local/a.txt', to: '/srv/a.txt' },
      { op: 'fastPut', path: '/local/b.txt', to: '/srv/b.txt' }
    ])
  })

  /**
   * The decisions are the answer to "this would overwrite something" — a file
   * marked skip must not be written, which is the entire promise the conflict
   * dialog makes.
   */
  it('writes what was allowed and leaves the skipped alone', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv': { dir: true } }))
    const decisions: TransferDecisions = {
      '/srv/keep.txt': 'skip',
      '/srv/replace.txt': 'overwrite'
    }

    const result = await sftpManager.runPlan(
      'conn',
      plan('upload', [
        item('/local/keep.txt', '/srv/keep.txt'),
        item('/local/replace.txt', '/srv/replace.txt'),
        item('/local/new.txt', '/srv/new.txt')
      ]),
      decisions
    )

    expect(result).toEqual({ written: 2, skipped: 1 })
    const written = calls.filter((c) => c.op === 'fastPut').map((c) => c.to)
    expect(written).toEqual(['/srv/replace.txt', '/srv/new.txt'])
  })

  it('creates the missing directories above a destination, deepest last', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv': { dir: true } }))

    await sftpManager.runPlan(
      'conn',
      plan('upload', [item('/local/deep.txt', '/srv/one/two/deep.txt')])
    )

    expect(calls.filter((c) => c.op === 'mkdir').map((c) => c.path)).toEqual([
      '/srv/one',
      '/srv/one/two'
    ])
  })

  it('does not create a directory that is already there', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv': { dir: true }, '/srv/one': { dir: true } }))

    await sftpManager.runPlan('conn', plan('upload', [item('/local/a.txt', '/srv/one/a.txt')]))

    expect(calls.some((c) => c.op === 'mkdir')).toBe(false)
  })

  it('downloads into a local directory it creates on the way', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv/a.txt': { size: 1024 } }))
    const dest = join(localDir, 'nested', 'deeper', 'a.txt')

    const result = await sftpManager.runPlan(
      'conn',
      plan('download', [item('/srv/a.txt', dest)])
    )

    expect(result).toEqual({ written: 1, skipped: 0 })
    expect(existsSync(join(localDir, 'nested', 'deeper'))).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe('fetched')

    /**
     * Fetched under another name and moved onto the destination at the end, so
     * a connection that drops halfway cannot leave a truncated file where a
     * whole one used to be. Nothing partial is left behind either.
     */
    expect(calls[0].to).not.toBe(dest)
    expect(calls[0].to).toMatch(/\.part-/)
    expect(readdirSync(join(localDir, 'nested', 'deeper'))).toEqual(['a.txt'])
  })

  /**
   * The dialog offers a choice; if the answer never arrives, the file it was
   * asked about must survive. This used to write it — the enforced default and
   * the offered one disagreed — so the check is here as well as on the rule
   * itself, because what matters is that the answer reaches the transfer.
   */
  it('leaves a conflicting destination alone when nothing was decided', async () => {
    const calls: Call[] = []
    attach('conn', stubSession(calls, { '/srv/a.txt': { size: 1024 } }))
    // beforeEach clears this directory; the other tests get it back because a
    // transfer makes its own, and this one writes before any transfer runs.
    mkdirSync(localDir, { recursive: true })
    const dest = join(localDir, 'a.txt')
    writeFileSync(dest, 'mine', 'utf8')

    const withConflict = plan('download', [item('/srv/a.txt', dest)])
    withConflict.conflicts = [
      { ...item('/srv/a.txt', dest), destSize: 4, destMtime: 0, reason: 'file' }
    ]

    const result = await sftpManager.runPlan('conn', withConflict)

    expect(result).toEqual({ written: 0, skipped: 1 })
    expect(readFileSync(dest, 'utf8')).toBe('mine')
    expect(calls).toEqual([])
  })

  it('reports progress against the file it is moving', async () => {
    attach('conn', stubSession([], { '/srv': { dir: true } }))
    const seen: Array<[number, number, string]> = []

    await sftpManager.runPlan(
      'conn',
      plan('upload', [item('/local/a.txt', '/srv/a.txt')]),
      {},
      (transferred, total, path) => seen.push([transferred, total, path])
    )

    expect(seen).toEqual([[512, 1024, '/local/a.txt']])
  })

  it('refuses a host-to-host copy with nowhere to put it', async () => {
    attach('conn', stubSession([]))

    await expect(
      sftpManager.runPlan('conn', plan('relay', [item('/srv/a.txt', '/srv/b.txt')]))
    ).rejects.toThrow(/needs a destination connection/i)
  })

  it('relays between two hosts, making the destination directory on the far side', async () => {
    const sourceCalls: Call[] = []
    const destCalls: Call[] = []
    const received: Record<string, string> = {}
    attach('source', stubSession(sourceCalls, { '/srv/a.txt': { size: 8 } }))
    attach('dest', stubSession(destCalls, { '/incoming': { dir: true } }, { received }))

    const result = await sftpManager.runPlan(
      'source',
      plan('relay', [item('/srv/a.txt', '/incoming/new/a.txt')]),
      {},
      undefined,
      'dest'
    )

    expect(result).toEqual({ written: 1, skipped: 0 })
    expect(sourceCalls.filter((c) => c.op === 'read').map((c) => c.path)).toEqual(['/srv/a.txt'])
    // The directory is made on the receiving host, not on the sending one.
    expect(destCalls.filter((c) => c.op === 'mkdir').map((c) => c.path)).toEqual(['/incoming/new'])
    expect(destCalls.filter((c) => c.op === 'write').map((c) => c.path)).toEqual([
      '/incoming/new/a.txt'
    ])
    expect(sourceCalls.some((c) => c.op === 'write')).toBe(false)
    // The bytes really travelled, rather than the call merely being made.
    expect(received).toEqual({ '/incoming/new/a.txt': 'the file' })
  })

  /**
   * A file the source refuses to open must leave nothing behind on the
   * destination. Opening both ends at once would create an empty file on the
   * far host for every permission error — a copy that looks like it worked
   * until someone opens the result.
   */
  it('never opens the destination when the source cannot be read', async () => {
    const sourceCalls: Call[] = []
    const destCalls: Call[] = []
    attach(
      'source',
      stubSession(sourceCalls, { '/srv/a.txt': { size: 8 } }, { failReadOpen: true })
    )
    attach('dest', stubSession(destCalls, { '/incoming': { dir: true } }))

    await expect(
      sftpManager.runPlan(
        'source',
        plan('relay', [item('/srv/a.txt', '/incoming/a.txt')]),
        {},
        undefined,
        'dest'
      )
    ).rejects.toThrow(/permission denied/i)

    expect(destCalls.some((c) => c.op === 'write')).toBe(false)
  })
})
