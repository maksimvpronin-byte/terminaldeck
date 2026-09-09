import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, Server, utils } from 'ssh2'
import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { ScpShell, parseShellStats, shellQuote } from './ScpShell'

const container = process.env.TD_SCP_CONTAINER
const canRun = process.platform !== 'win32'

describe('shell metadata', () => {
  it('keeps spaces, quotes and newlines in file names and special mode bits', () => {
    const [entry] = parseShellStats(
      Buffer.from("/tmp/a 'b\nc\0" + '81ed\0' + '7\0' + '123\0' + '1000\0' + '1001\0')
    )
    expect(entry.name).toBe("a 'b\nc")
    expect(entry.permissions).toBe('755')
    expect(entry.size).toBe(7)
  })
  it('rejects banners, incomplete records and NUL paths', () => {
    expect(() => parseShellStats(Buffer.from('welcome'))).toThrow()
    expect(() => shellQuote('a\0b')).toThrow()
    expect(shellQuote("a'$(touch /tmp/no)")).toBe("'a'\"'\"'$(touch /tmp/no)'")
  })
})

/** Real SSH command channels and the system SCP binary, no SFTP subsystem. */
describe.skipIf(!canRun)('SCP over SSH', () => {
  const local = mkdtempSync(join(tmpdir(), 'td-scp-'))
  let server: Server
  let client: Client
  let shell: ScpShell
  let root: string
  beforeAll(async () => {
    const keys = utils.generateKeyPairSync('ed25519')
    server = new Server({ hostKeys: [keys.private] }, (connection) => {
      connection
        .on('authentication', (ctx) => ctx.accept())
        .on('ready', () => {
          connection.on('session', (accept) => {
            const session = accept()
            session.on('exec', (acceptExec, _reject, info) => {
              const channel = acceptExec()
              const child = container
                ? spawn('docker', [
                    'exec',
                    '-i',
                    '-u',
                    'tester',
                    container,
                    'sh',
                    '-c',
                    info.command
                  ])
                : spawn('sh', ['-c', info.command])
              channel.pipe(child.stdin)
              child.stdout.pipe(channel, { end: false })
              child.stderr.pipe(channel.stderr, { end: false })
              child.stdin.on('error', () => undefined)
              child.on('close', (code) => {
                channel.exit(code ?? 1)
                channel.end()
              })
              channel.on('close', () => child.kill())
            })
          })
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    client = new Client()
    await new Promise<void>((resolve, reject) => {
      client
        .on('ready', resolve)
        .on('error', reject)
        .connect({
          host: '127.0.0.1',
          port: (server.address() as { port: number }).port,
          username: 'tester',
          password: 'test'
        })
    })
    shell = new ScpShell(client, container ? 'sudo -n -i -u postgres' : 'env')
    root = container ? `/srv/private/test-${Date.now()}` : local
    if (container) execFileSync('docker', ['exec', '-u', 'postgres', container, 'mkdir', root])
  })
  afterAll(async () => {
    shell?.close()
    client?.end()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (container && root)
      execFileSync('docker', ['exec', '-u', 'postgres', container, 'rm', '-rf', '--', root])
    rmSync(local, { recursive: true, force: true })
  })

  it('streams binary data and empty files in both directions', async () => {
    for (const data of [
      Buffer.alloc(0),
      Buffer.from(Array.from({ length: 180_000 }, (_, i) => i % 256))
    ]) {
      const path = `${root}/binary '☃.bin`
      await pipeline(Readable.from([data]), shell.createWriteStream(path, data.length))
      const chunks: Buffer[] = []
      for await (const chunk of shell.createReadStream(path)) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks)).toEqual(data)
    }
  }, 30_000)

  it('rejects a cancelled transfer and closes the command channels', async () => {
    const cancelled = new ScpShell(client, container ? 'sudo -n -i -u postgres' : 'env')
    const read = cancelled.createReadStream(`${root}/binary '☃.bin`)
    read.once('data', () => cancelled.close())
    await expect(
      (async () => {
        for await (const chunk of read) void chunk
      })()
    ).rejects.toThrow()
  })

  it('rejects shell banners instead of treating them as file content', async () => {
    const noisy = new ScpShell(client, "printf 'banner\\n'; env")
    const read = noisy.createReadStream(`${root}/binary '☃.bin`)
    await expect(
      (async () => {
        for await (const chunk of read) void chunk
      })()
    ).rejects.toThrow(/header/)
    noisy.close()
  })

  it('rejects missing sources and destination errors', async () => {
    await expect(
      pipeline(
        shell.createReadStream(`${root}/missing`),
        new (await import('stream')).PassThrough()
      )
    ).rejects.toThrow()
    await expect(
      pipeline(Readable.from(['x']), shell.createWriteStream(`${root}/missing/child`, 1))
    ).rejects.toThrow()
  })

  it('rejects a source whose advertised size changes', async () => {
    await expect(
      pipeline(Readable.from(['too long']), shell.createWriteStream(`${root}/changed`, 1))
    ).rejects.toThrow('grew')
    await expect(
      pipeline(Readable.from(['x']), shell.createWriteStream(`${root}/short`, 2))
    ).rejects.toThrow('size changed')
  })

  it.skipIf(!container && process.platform !== 'linux')(
    'lists, resolves, renames, transfers and deletes using the configured identity',
    async () => {
      const name = "folder ' $(touch SHOULD_NOT_EXIST)\nname"
      const dir = `${root}/${name}`
      await shell.mkdir(dir)
      expect(await shell.realpath(dir)).toBe(dir)
      await shell.mkdir(`${dir}/nested`)
      const source = join(local, 'source')
      const destination = join(local, 'download')
      writeFileSync(source, 'hello\0binary')
      await shell.upload(source, `${dir}/data`)
      await shell.download(`${dir}/data`, destination)
      expect(readFileSync(destination)).toEqual(readFileSync(source))
      await shell.rename(`${dir}/data`, `${dir}/renamed`)
      await shell.upload(source, `${dir}/data`)
      await expect(shell.rename(`${dir}/data`, `${dir}/renamed`)).rejects.toThrow(/exists/)
      await shell.remove(`${dir}/data`, false)
      expect((await shell.list(dir)).map((e) => e.name).sort()).toEqual(['nested', 'renamed'])
      expect(await shell.statPath(`${dir}/missing`)).toBeNull()
      await shell.remove(`${dir}/renamed`, false)
      await shell.remove(`${dir}/nested`, true)
      await shell.remove(dir, true)
      if (container) {
        const special = `${root}/link-target`
        execFileSync('docker', [
          'exec',
          '-u',
          'postgres',
          container,
          'sh',
          '-c',
          `printf test > '${special}'; chmod 640 '${special}'; ln -s '${special}' '${root}/link'`
        ])
        await shell.upload(source, `${root}/link`)
        expect((await shell.statPath(special))?.permissions).toBe('640')
        expect((await shell.statPath(`${root}/link`))?.isSymlink).toBe(true)
        await shell.remove(`${root}/link`, false)
        expect(await shell.statPath(special)).not.toBeNull()
        expect(
          execFileSync('docker', ['exec', container, 'stat', '-c', '%U', `${root}/binary '☃.bin`], {
            encoding: 'utf8'
          }).trim()
        ).toBe('postgres')
      }
    },
    30_000
  )

  it.skipIf(!container)(
    'denies access as the login user and refuses disallowed sudo without fallback',
    async () => {
      const login = new ScpShell(client, 'env')
      const denied = new ScpShell(client, 'sudo -n -i -u root')
      await expect(login.list(root)).rejects.toThrow(/Permission denied/)
      await expect(denied.list(root)).rejects.toThrow(/sudo|password|allowed/)
      login.close()
      denied.close()
    }
  )
})
