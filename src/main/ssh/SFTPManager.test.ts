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
const { sshManager } = await import('./SSHManager')
const { ScpShell } = await import('./ScpShell')

const localDir = mkdtempSync(join(tmpdir(), 'terminaldeck-sftp-local-'))

/** One recorded call on a stub session: what was asked for, and of what. */
interface Call {
  op: 'fastPut' | 'fastGet' | 'mkdir' | 'read' | 'write' | 'rename' | 'posixRename' | 'unlink'
  path: string
  to?: string
}

interface Entry {
  size?: number
  dir?: boolean
  mode?: number
  uid?: number
}

/** Where a partial name put down for `path` would be, by its prefix. */
const PARTIAL = /\/\.[^/]+\.td-partial-\d+-\d+$/

/**
 * A stand-in for one host's SFTP session. `entries` is what it claims to
 * already hold; everything else is reported missing, which is what makes the
 * manager create the parent directories. Anything written to it lands in
 * `received`, keyed by path.
 */
function stubSession(
  calls: Call[],
  entries: Record<string, Entry> = {},
  opts: {
    failReadOpen?: boolean
    received?: Record<string, string>
    /** Stops a write partway, the way a dropped link does. */
    failWrite?: boolean
  } = {}
): SFTPWrapper {
  const move = (from: string, to: string): void => {
    entries[to] = entries[from]
    delete entries[from]
    if (opts.received && from in opts.received) {
      opts.received[to] = opts.received[from]
      delete opts.received[from]
    }
  }
  const session = {
    fastPut(
      local: string,
      remote: string,
      transfer: { step?: (t: number, chunk: number, total: number) => void },
      cb: (err?: Error | null) => void
    ): void {
      calls.push({ op: 'fastPut', path: local, to: remote })
      transfer.step?.(512, 512, 1024)
      if (opts.failWrite) {
        entries[remote] = { size: 512, mode: 0o600, uid: 0 }
        cb(new Error('Connection lost'))
        return
      }
      entries[remote] = { size: 1024, mode: 0o600, uid: 0 }
      cb(null)
    },
    rename(from: string, to: string, cb: (err?: Error | null) => void): void {
      calls.push({ op: 'rename', path: from, to })
      // SSH_FXP_RENAME as most servers have it: never over an existing name.
      if (entries[to]) return cb(new Error('Failure'))
      move(from, to)
      cb(null)
    },
    ext_openssh_rename(from: string, to: string, cb: (err?: Error | null) => void): void {
      calls.push({ op: 'posixRename', path: from, to })
      move(from, to)
      cb(null)
    },
    chmod(path: string, mode: number, cb: (err?: Error | null) => void): void {
      if (entries[path]) entries[path].mode = mode
      cb(null)
    },
    chown(path: string, uid: number, _gid: number, cb: (err?: Error | null) => void): void {
      if (entries[path]) entries[path].uid = uid
      cb(null)
    },
    unlink(path: string, cb: (err?: Error | null) => void): void {
      calls.push({ op: 'unlink', path })
      delete entries[path]
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
        mode: entry.mode ?? 0o644,
        uid: entry.uid ?? 0,
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
          entries[path] = { size: Buffer.concat(chunks).length }
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

    expect(result).toEqual({ written: 2, skipped: 0, changed: [] })
    // Each goes up under a name of its own and is moved into place at the end.
    const puts = calls.filter((c) => c.op === 'fastPut')
    expect(puts.map((c) => c.path)).toEqual(['/local/a.txt', '/local/b.txt'])
    for (const put of puts) expect(put.to).toMatch(PARTIAL)
    expect(calls.filter((c) => c.op === 'rename').map((c) => c.to)).toEqual([
      '/srv/a.txt',
      '/srv/b.txt'
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

    expect(result).toEqual({ written: 2, skipped: 1, changed: [] })
    const written = calls.filter((c) => c.op === 'rename').map((c) => c.to)
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

    const result = await sftpManager.runPlan('conn', plan('download', [item('/srv/a.txt', dest)]))

    expect(result).toEqual({ written: 1, skipped: 0, changed: [] })
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

    expect(result).toEqual({ written: 0, skipped: 1, changed: [] })
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

    expect(seen).toEqual([
      [512, 1024, '/local/a.txt'],
      [1024, 1024, '/local/a.txt']
    ])
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

    expect(result).toEqual({ written: 1, skipped: 0, changed: [] })
    expect(sourceCalls.filter((c) => c.op === 'read').map((c) => c.path)).toEqual(['/srv/a.txt'])
    // The directory is made on the receiving host, not on the sending one.
    expect(destCalls.filter((c) => c.op === 'mkdir').map((c) => c.path)).toEqual(['/incoming/new'])
    const writes = destCalls.filter((c) => c.op === 'write').map((c) => c.path)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(PARTIAL)
    expect(destCalls.filter((c) => c.op === 'rename').map((c) => c.to)).toEqual([
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

/**
 * What a transfer leaves behind when it does not finish, and what it does to a
 * destination that changed after the plan was made.
 */
describe('replacing a remote file', () => {
  it('leaves the original whole when an upload over it stops halfway', async () => {
    const calls: Call[] = []
    const entries: Record<string, Entry> = {
      '/srv': { dir: true },
      '/srv/app.conf': { size: 4096 }
    }
    attach('conn', stubSession(calls, entries, { failWrite: true }))

    const overwrite = plan('upload', [item('/local/app.conf', '/srv/app.conf')])
    overwrite.conflicts = [
      { ...item('/local/app.conf', '/srv/app.conf'), destSize: 4096, destMtime: 0, reason: 'file' }
    ]
    await expect(
      sftpManager.runPlan('conn', overwrite, { '/srv/app.conf': 'overwrite' })
    ).rejects.toThrow(/connection lost/i)

    // The original is untouched, and the half that did arrive is gone.
    expect(entries['/srv/app.conf']).toEqual({ size: 4096 })
    expect(calls.some((c) => c.op === 'fastPut' && c.to === '/srv/app.conf')).toBe(false)
    expect(Object.keys(entries).filter((p) => PARTIAL.test(p))).toEqual([])
  })

  it('replaces an existing file keeping its mode and owner', async () => {
    const calls: Call[] = []
    const entries: Record<string, Entry> = {
      '/srv': { dir: true },
      '/srv/app.conf': { size: 4096, mode: 0o640, uid: 33 }
    }
    attach('conn', stubSession(calls, entries))

    const overwrite = plan('upload', [item('/local/app.conf', '/srv/app.conf')])
    overwrite.conflicts = [
      { ...item('/local/app.conf', '/srv/app.conf'), destSize: 4096, destMtime: 0, reason: 'file' }
    ]
    await sftpManager.runPlan('conn', overwrite, { '/srv/app.conf': 'overwrite' })

    expect(calls.filter((c) => c.op === 'posixRename').map((c) => c.to)).toEqual(['/srv/app.conf'])
    expect(entries['/srv/app.conf']).toMatchObject({ size: 1024, mode: 0o640, uid: 33 })
  })

  it('does not write over something that appeared after the plan was made', async () => {
    const calls: Call[] = []
    const entries: Record<string, Entry> = { '/srv': { dir: true } }
    attach('conn', stubSession(calls, entries))
    // Planned against an empty directory; by the time it runs, a file is there.
    const planned = plan('upload', [item('/local/a.txt', '/srv/a.txt')])
    entries['/srv/a.txt'] = { size: 7 }

    const result = await sftpManager.runPlan('conn', planned)

    expect(result).toEqual({ written: 0, skipped: 1, changed: ['/srv/a.txt'] })
    expect(entries['/srv/a.txt']).toEqual({ size: 7 })
    expect(calls.some((c) => c.op === 'fastPut')).toBe(false)
  })
})

describe('folders with nothing in them', () => {
  it('makes an empty folder at the destination', async () => {
    mkdirSync(join(localDir, 'project', 'logs'), { recursive: true })
    writeFileSync(join(localDir, 'project', 'README'), 'hi', 'utf8')
    const calls: Call[] = []
    const entries: Record<string, Entry> = { '/srv': { dir: true } }
    attach('conn', stubSession(calls, entries))

    const planned = await sftpManager.planUpload('conn', join(localDir, 'project'), '/srv')
    const result = await sftpManager.runPlan('conn', planned)

    expect(planned.items.filter((i) => i.isDirectory).map((i) => i.destPath)).toEqual([
      '/srv/project/logs'
    ])
    expect(result.written).toBe(2)
    expect(entries['/srv/project/logs']).toEqual({ dir: true })
  })
})

describe('SCP/Shell routing', () => {
  it.each(['source', 'destination'])(
    'relays between SFTP and SCP with the SCP endpoint as %s',
    async (side) => {
      const received: Record<string, string> = {}
      const calls: Call[] = []
      const stub = stubSession(calls, { '/file': { size: 8 } }, { received })
      vi.spyOn(sshManager, 'getFileAccess').mockImplementation((id) =>
        id === side ? { protocol: 'scp', shell: 'sudo -n -i -u postgres' } : undefined
      )
      vi.spyOn(sshManager, 'getClientChain').mockReturnValue([{} as import('ssh2').Client])
      vi.spyOn(ScpShell.prototype, 'statPath').mockResolvedValue({
        name: 'file',
        path: '/file',
        size: 8,
        mtime: 0,
        permissions: '640',
        isDirectory: false,
        isSymlink: false,
        owner: '1',
        group: '1'
      })
      vi.spyOn(ScpShell.prototype, 'createReadStream').mockImplementation(
        (path) => stub.createReadStream(path) as unknown as PassThrough
      )
      // Replacing through a partial name is a shell script of its own; the
      // routing is what is under test here, so it writes straight through.
      vi.spyOn(ScpShell.prototype, 'replace').mockImplementation((path, write) => write(path))
      const write = vi
        .spyOn(ScpShell.prototype, 'createWriteStream')
        .mockImplementation((path) => stub.createWriteStream(path))
      attach(side === 'source' ? 'destination' : 'source', stub)
      await sftpManager.relay('source', '/file', 'destination', '/copy')
      expect(received['/copy']).toBe('the file')
      if (side === 'destination') expect(write).toHaveBeenCalledWith('/copy', 8, '640')
      sftpManager.releaseConnection('source')
      sftpManager.releaseConnection('destination')
    }
  )

  it('uses shell operations for a configured connection and never opens SFTP', async () => {
    const sftp = vi.fn()
    vi.spyOn(sshManager, 'getFileAccess').mockReturnValue({
      protocol: 'scp',
      shell: 'sudo -n -i -u postgres'
    })
    vi.spyOn(sshManager, 'getClientChain').mockReturnValue([
      { sftp } as unknown as import('ssh2').Client
    ])
    const list = vi.spyOn(ScpShell.prototype, 'list').mockResolvedValue([])
    const mkdir = vi.spyOn(ScpShell.prototype, 'mkdir').mockResolvedValue()
    const remove = vi.spyOn(ScpShell.prototype, 'remove').mockResolvedValue()
    const close = vi.spyOn(ScpShell.prototype, 'close')
    await sftpManager.list('scp-routing', '/srv/private')
    await sftpManager.mkdir('scp-routing', '/srv/private/new')
    await sftpManager.delete('scp-routing', '/srv/private/new', true)
    expect(list).toHaveBeenCalledWith('/srv/private')
    expect(mkdir).toHaveBeenCalledWith('/srv/private/new')
    expect(remove).toHaveBeenCalledWith('/srv/private/new', true)
    expect(sftp).not.toHaveBeenCalled()
    sftpManager.releaseConnection('scp-routing')
    expect(close).toHaveBeenCalled()
  })
})

describe('parallel transfer planning', () => {
  it('checks metadata concurrently while preserving unreadable conflicts', async () => {
    mkdirSync(localDir, { recursive: true })
    for (let i = 0; i < 24; i++) writeFileSync(join(localDir, `file-${i}`), 'data')
    let active = 0,
      peak = 0
    const stat = vi.spyOn(sftpManager, 'statPath').mockImplementation(async (_id, path) => {
      peak = Math.max(peak, ++active)
      await new Promise<void>((resolve) => setImmediate(resolve))
      active--
      if (path.endsWith('/file-3')) throw new Error('Permission denied')
      return null
    })
    const planned = await sftpManager.planUpload('conn', localDir, '/remote')
    expect(peak).toBe(8)
    expect(stat).toHaveBeenCalledTimes(24)
    expect(planned.items).toHaveLength(24)
    expect(planned.conflicts).toHaveLength(1)
    expect(planned.conflicts[0]).toMatchObject({ reason: 'unreadable' })
    expect(planned.conflicts[0].destPath).toMatch(/\/file-3$/)
  })
  it('opens only one SFTP channel for concurrent requests', async () => {
    let complete!: (error: Error | null, sftp: SFTPWrapper) => void
    const open = vi.fn((callback: typeof complete) => {
      complete = callback
    })
    vi.spyOn(sshManager, 'getClientChain').mockReturnValue([
      { sftp: open }
    ] as unknown as ReturnType<typeof sshManager.getClientChain>)
    const pending = Promise.all(
      Array.from({ length: 8 }, (_, i) => sftpManager.statPath('new', `/file-${i}`))
    )
    expect(open).toHaveBeenCalledTimes(1)
    complete(null, stubSession([]))
    expect(await pending).toEqual(Array(8).fill(null))
    sftpManager.releaseConnection('new')
  })
  it('does not cache a channel that finishes opening after disconnect', async () => {
    let complete!: (error: Error | null, sftp: SFTPWrapper) => void
    vi.spyOn(sshManager, 'getClientChain').mockReturnValue([
      {
        sftp: (callback: typeof complete) => {
          complete = callback
        }
      }
    ] as unknown as ReturnType<typeof sshManager.getClientChain>)
    const pending = Promise.allSettled([
      sftpManager.statPath('closing', '/file'),
      sftpManager.statPath('closing', '/other')
    ])
    sftpManager.releaseConnection('closing')
    const sftp = stubSession([])
    sftp.end = vi.fn()
    complete(null, sftp)
    const results = await pending
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(sftp.end).toHaveBeenCalledTimes(1)
    expect(
      (sftpManager as unknown as { sessions: Map<string, SFTPWrapper> }).sessions.has('closing')
    ).toBe(false)
  })
})
