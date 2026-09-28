import type { Client, ClientChannel } from 'ssh2'
import { PassThrough, Writable } from 'stream'
import { pipeline } from 'stream/promises'
import { createWriteStream } from 'fs'
import { open } from 'fs/promises'
import { posix } from 'path'
import { randomBytes } from 'crypto'
import type { SftpEntry } from '../../shared/types'

/** Shell paths are data, including quotes, newlines and leading dashes. */
export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A remote path cannot contain NUL')
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function pathArg(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${shellQuote(path.slice(2))}`
  return shellQuote(path.startsWith('/') ? path : `./${path}`)
}

/** A bounded incremental reader for SCP's binary ACKs, headers and file bytes. */
class Reader {
  private held = Buffer.alloc(0)
  private iterator: AsyncIterator<Buffer>
  constructor(
    private channel: ClientChannel,
    private diagnostic: () => string
  ) {
    this.iterator = channel[Symbol.asyncIterator]()
  }
  private async next(): Promise<IteratorResult<Buffer>> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.channel.destroy()
            reject(
              new Error(
                'SCP/Shell timed out. Check sudo permissions; interactive passwords are not supported.'
              )
            )
          }, 30_000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async take(max: number): Promise<Buffer> {
    if (!this.held.length) {
      const next = await this.next()
      if (next.done)
        throw new Error(this.diagnostic() || 'SCP channel closed before the transfer completed')
      this.held = Buffer.from(next.value)
    }
    const result = this.held.subarray(0, max)
    this.held = this.held.subarray(result.length)
    return result
  }
  async finish(): Promise<void> {
    if (this.held.length) throw new Error('Unexpected data after SCP transfer')
    const next = await this.next()
    if (!next.done) throw new Error('Unexpected data after SCP transfer')
  }
  async line(): Promise<string> {
    const bytes: number[] = []
    while (bytes.length < 8192) {
      const byte = (await this.take(1))[0]
      if (byte === 10) return Buffer.from(bytes).toString('utf8')
      bytes.push(byte)
    }
    throw new Error('Invalid or oversized SCP response')
  }
  async ack(): Promise<void> {
    const code = (await this.take(1))[0]
    if (code === 0) return
    if (code === 1 || code === 2) throw new Error(await this.line())
    throw new Error(
      'Invalid SCP response. The login shell must not print banners on command channels.'
    )
  }
}

/** Fields `STAT` prints for each path, each ended by a NUL. */
const STAT_FIELDS = 8

/**
 * The name `stat` prints, or the number when it has none.
 *
 * GNU stat answers `UNKNOWN` for an id with no entry in the server's user or
 * group database — files unpacked from somebody else's archive, or owned by a
 * container's user — and the number says more than that word does.
 */
function nameOr(name: string, id: string): string {
  return name && name !== 'UNKNOWN' ? name : id
}

export function parseShellStats(output: Buffer): SftpEntry[] {
  if (!output.length) return []
  const fields = output.toString('utf8').split('\0')
  if (fields.pop() !== '' || fields.length % STAT_FIELDS)
    throw new Error('Invalid shell file listing (GNU stat is required)')
  const entries: SftpEntry[] = []
  for (let i = 0; i < fields.length; i += STAT_FIELDS) {
    const [path, hex, size, mtime, uid, gid, user, group] = fields.slice(i, i + STAT_FIELDS)
    const mode = Number.parseInt(hex, 16)
    if (!/^[0-9a-f]+$/i.test(hex) || !/^\d+$/.test(size) || !/^-?\d+$/.test(mtime)) {
      throw new Error('Invalid shell file metadata')
    }
    entries.push({
      name: posix.basename(path),
      path,
      size: Number(size),
      mtime: Number(mtime) * 1000,
      isDirectory: (mode & 0o170000) === 0o040000,
      isSymlink: (mode & 0o170000) === 0o120000,
      permissions: (mode & 0o7777).toString(8),
      // Names, as SFTP shows them from its listing lines: the ids alone left
      // every row of an SCP/Shell panel reading 26 26 where it meant postgres.
      owner: nameOr(user, uid),
      group: nameOr(group, gid)
    })
  }
  return entries
}

const STAT = "stat --printf '%n\\0%f\\0%s\\0%Y\\0%u\\0%g\\0%U\\0%G\\0' --"

/** Linux SCP/Shell backend. Every command uses the same locally configured identity. */
export class ScpShell {
  private channels = new Set<ClientChannel>()
  private closed = false
  constructor(
    private client: Client,
    private shell: string
  ) {
    if (!shell.trim() || /[\r\n\0]/.test(shell))
      throw new Error('Set a single-line SCP shell command')
  }

  private async open(command: string) {
    if (this.closed) throw new Error('File connection closed')
    // sudo -i reconstructs a login-shell command and can consume literal newlines.
    // Send an ASCII script envelope so paths survive that extra shell unchanged.
    const encoded = Buffer.from(`export LC_ALL=C; ${command}`).toString('base64')
    const script = `command -v base64 >/dev/null || exit 127; eval "$(printf %s ${encoded} | base64 -d)"`
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      // The configured prefix launches a command, e.g. sudo -n -i -u postgres.
      this.client.exec(`${this.shell} sh -c ${shellQuote(script)}`, (err, ch) =>
        err ? reject(err) : resolve(ch)
      )
    })
    if (this.closed) {
      channel.destroy()
      throw new Error('File connection closed')
    }
    this.channels.add(channel)
    let diagnostic = ''
    channel.stderr.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString('utf8')).slice(-8192)
    })
    const done = new Promise<void>((resolve, reject) => {
      channel.on('error', reject)
      channel.on('close', (code: number | null) => {
        this.channels.delete(channel)
        if (code === 0) resolve()
        else
          reject(
            new Error(
              diagnostic.trim() || `SCP/Shell command failed (${code ?? 'connection closed'})`
            )
          )
      })
    })
    // A protocol reader may still be processing when the exit arrives.
    void done.catch(() => undefined)
    return { channel, done, reader: new Reader(channel, () => diagnostic.trim()) }
  }

  private async capture(
    command: string,
    timeout = {
      ms: 30_000,
      message: 'SCP/Shell command timed out; interactive sudo passwords are not supported'
    }
  ): Promise<Buffer> {
    const { channel, done } = await this.open(command)
    const timer = setTimeout(() => channel.emit('error', new Error(timeout.message)), timeout.ms)
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of channel) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new Error('Shell listing exceeds 16 MB')
        chunks.push(Buffer.from(chunk))
      }
      await done
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timer)
      channel.destroy()
    }
  }

  async realpath(path: string): Promise<string> {
    const result = await this.capture(`realpath -e -z -- ${pathArg(path)}`)
    if (result.at(-1) !== 0 || result.subarray(0, -1).includes(0))
      throw new Error('Invalid realpath response (GNU coreutils is required)')
    return result.subarray(0, -1).toString('utf8')
  }
  async list(path: string): Promise<SftpEntry[]> {
    const absolute = await this.realpath(path)
    return parseShellStats(
      await this.capture(`find ${shellQuote(absolute)} -mindepth 1 -maxdepth 1 -exec ${STAT} {} +`)
    )
  }
  /**
   * Everything under `path` whose name matches `glob`, case ignored — one
   * `find` on the server rather than a listing per folder.
   *
   * Folders it may not read are passed over rather than failing the search,
   * which is why errors are discarded and the exit status ignored: `find`
   * answers 1 for a single unreadable folder among a thousand good ones. One
   * more than the limit is asked for, so a cut can be told from an exact fit.
   */
  async find(
    path: string,
    glob: string,
    limit: number
  ): Promise<{ root: string; entries: SftpEntry[]; truncated: boolean }> {
    const root = await this.realpath(path)
    const output = await this.capture(
      `find ${shellQuote(root)} -mindepth 1 -iname ${shellQuote(glob)} -print0 2>/dev/null` +
        ` | head -z -n ${limit + 1} | xargs -0 -r ${STAT} 2>/dev/null; exit 0`,
      { ms: 60_000, message: 'The search took longer than a minute; search a smaller folder' }
    )
    const entries = parseShellStats(output)
    return { root, entries: entries.slice(0, limit), truncated: entries.length > limit }
  }
  async statPath(path: string, follow = false): Promise<SftpEntry | null> {
    try {
      const entries = parseShellStats(
        await this.capture(`${follow ? STAT.replace('stat ', 'stat -L ') : STAT} ${pathArg(path)}`)
      )
      if (entries.length !== 1) throw new Error('Invalid stat response')
      return { ...entries[0], path, name: posix.basename(path) }
    } catch (err) {
      if (/No such file or directory/.test((err as Error).message)) return null
      throw err
    }
  }
  async mkdir(path: string): Promise<void> {
    await this.capture(`mkdir -- ${pathArg(path)}`)
  }
  async rename(from: string, to: string): Promise<void> {
    await this.capture(
      `mv -T -n -- ${pathArg(from)} ${pathArg(to)} && { if test -e ${pathArg(from)} || test -L ${pathArg(from)}; then printf '%s\\n' 'Destination already exists' >&2; exit 1; fi; }`
    )
  }
  async remove(path: string, directory: boolean): Promise<void> {
    await this.capture(`${directory ? 'rmdir' : 'rm'} -- ${pathArg(path)}`)
  }

  createReadStream(path: string): PassThrough {
    const out = new PassThrough()
    let channel: ClientChannel | undefined
    out.on('close', () => channel?.destroy())
    void (async () => {
      const session = await this.open(`exec scp -f -- ${pathArg(path)}`)
      channel = session.channel
      if (out.destroyed) {
        channel.destroy()
        return
      }
      channel.write(Buffer.from([0]))
      const header = await session.reader.line()
      if (header.charCodeAt(0) === 1 || header.charCodeAt(0) === 2) throw new Error(header.slice(1))
      const match = /^C[0-7]{4} (\d+) (.+)$/.exec(header)
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw new Error('Invalid SCP file header')
      let remaining = Number(match[1])
      channel.write(Buffer.from([0]))
      out.emit('open')
      while (remaining > 0) {
        const bytes = await session.reader.take(Math.min(remaining, 64 * 1024))
        remaining -= bytes.length
        if (!out.write(bytes))
          await new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
              out.off('drain', drained)
              out.off('close', closed)
              out.off('error', failed)
            }
            const drained = (): void => {
              cleanup()
              resolve()
            }
            const closed = (): void => {
              cleanup()
              reject(new Error('Transfer cancelled'))
            }
            const failed = (err: Error): void => {
              cleanup()
              reject(err)
            }
            out.once('drain', drained).once('close', closed).once('error', failed)
          })
      }
      await session.reader.ack()
      channel.end(Buffer.from([0]))
      await session.reader.finish()
      await session.done
      out.end()
    })().catch((err) => {
      channel?.destroy()
      out.destroy(err)
    })
    return out
  }

  createWriteStream(path: string, size: number, mode = '0644'): Writable {
    if (!Number.isSafeInteger(size) || size < 0 || !/^[0-7]{3,4}$/.test(mode))
      throw new Error('Invalid SCP size or permissions')
    let channel: ClientChannel | undefined
    let sent = 0
    const ready = this.open(`test ! -d ${pathArg(path)} && exec scp -t -- ${pathArg(path)}`).then(
      async (session) => {
        channel = session.channel
        if (out.destroyed) {
          channel.destroy()
          throw new Error('Transfer cancelled')
        }
        await session.reader.ack()
        channel.write(`C${mode.padStart(4, '0')} ${size} file\n`)
        await session.reader.ack()
        return session
      }
    )
    const out = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void ready
          .then(async () => {
            sent += chunk.length
            if (sent > size) throw new Error('Source grew during SCP upload')
            await new Promise<void>((resolve, reject) =>
              channel!.write(chunk, (err?: Error | null) => (err ? reject(err) : resolve()))
            )
          })
          .then(() => callback(), callback)
      },
      final: (callback) => {
        void ready
          .then(async (session) => {
            if (sent !== size) throw new Error('Source size changed during SCP upload')
            channel!.write(Buffer.from([0]))
            await session.reader.ack()
            channel!.end()
            await session.reader.finish()
            await session.done
          })
          .then(() => callback(), callback)
      },
      destroy: (err, callback) => {
        channel?.destroy()
        callback(err)
      }
    })
    void ready.catch((err) => out.destroy(err))
    return out
  }

  async download(
    path: string,
    local: string,
    progress?: (n: number, total: number) => void
  ): Promise<void> {
    const total = (await this.statPath(path))?.size ?? 0
    const read = this.createReadStream(path)
    let count = 0
    read.on('data', (chunk) => {
      count += chunk.length
      progress?.(count, total)
    })
    await pipeline(read, createWriteStream(local, { flags: 'wx' }))
  }
  async upload(
    local: string,
    path: string,
    progress?: (n: number, total: number) => void
  ): Promise<void> {
    const handle = await open(local, 'r')
    try {
      const source = await handle.stat()
      if (!source.isFile()) throw new Error('SCP uploads require a regular file')
      const existing = await this.statPath(path, true)
      await this.replace(path, async (target) => {
        const write = this.createWriteStream(target, source.size, existing?.permissions ?? '0644')
        let count = 0
        const read = handle.createReadStream({ start: 0, autoClose: false })
        read.on('data', (chunk) => {
          count += chunk.length
          progress?.(count, source.size)
        })
        await pipeline(read, write)
      })
    } finally {
      await handle.close()
    }
  }

  /**
   * Writes `path` through a hidden name beside it and moves that into place,
   * so a transfer that stops halfway leaves the old file rather than half of
   * the new one. The same rules as `SFTPManager.writeRemoteFile`, in shell: the
   * mode and owner are taken from the file being replaced, and where the owner
   * cannot be matched nothing is replaced and the reason is given — never a
   * write over the original. `mv` renames, so the swap itself is atomic. A
   * destination that did not exist is not replaced if something appeared there
   * meanwhile, and a symlink's target is replaced rather than the link.
   */
  async replace(path: string, write: (target: string) => Promise<void>): Promise<void> {
    let target = path
    let existing = await this.statPath(path)
    if (existing?.isSymlink) {
      const resolved = await this.capture(`readlink -f -z -- ${pathArg(path)}`)
      if (resolved.at(-1) !== 0) throw new Error(`${path} is a link that cannot be followed`)
      target = resolved.subarray(0, -1).toString('utf8')
      existing = await this.statPath(target)
    }
    if (existing?.isDirectory) throw new Error(`Refusing to write over the directory ${target}`)

    const partial = posix.join(
      posix.dirname(target),
      // Random, as in SFTPManager.partialNameFor: a counted name could be guessed
      // and a link put there first, which `scp -t` would then write through.
      `.${posix.basename(target)}.td-partial-${randomBytes(8).toString('hex')}`
    )
    const [p, d] = [pathArg(partial), pathArg(target)]
    let moved = false
    try {
      await write(partial)
      if (!existing) {
        await this.capture(
          `mv -T -n -- ${p} ${d}; if test -e ${p}; then printf '%s\\n' 'Destination appeared during the transfer and was left alone' >&2; exit 1; fi`
        )
        moved = true
      } else {
        const outcome = await this.capture(
          `if test "$(stat -c %u:%g -- ${p})" != "$(stat -c %u:%g -- ${d})" && ! chown --reference=${d} -- ${p} 2>/dev/null; then printf owner; exit 0; fi; chmod --reference=${d} -- ${p} && mv -f -T -- ${p} ${d} && printf moved`
        )
        moved = outcome.toString('utf8') === 'moved'
        if (!moved) {
          throw new Error(
            `${target} was left unchanged: this login cannot give a new copy the owner the file has. Replacing it would change who owns it, and writing over it in place would destroy it if the transfer stopped halfway.`
          )
        }
      }
    } finally {
      if (!moved) await this.capture(`rm -f -- ${p}`).catch(() => undefined)
    }
  }

  close(): void {
    this.closed = true
    for (const channel of this.channels) channel.destroy()
    this.channels.clear()
  }
}
