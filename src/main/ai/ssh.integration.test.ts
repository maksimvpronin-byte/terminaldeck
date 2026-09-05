import { it, expect } from 'vitest'
import { Client, Server } from 'ssh2'
import { generateKeyPairSync } from 'crypto'
import { once } from 'events'
import { executeDiagnostic } from './execute'

/** Real SSH transport with a fixture server; never executes a host shell. */
it('runs isolated SSH exec channels, receives stderr/exit, and cancels a stalled command', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const commands: string[] = []
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connection.on('authentication', (ctx) => ctx.accept())
    connection.on('ready', () =>
      connection.on('session', (accept) => {
        const session = accept()
        session.on('exec', (accept, _reject, info) => {
          commands.push(info.command)
          const stream = accept()
          if (info.command === 'stalled') return
          stream.write('disk sample\n')
          stream.stderr.write('fixture warning\n')
          stream.exit(7)
          stream.end()
        })
      })
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const ssh = new Client()
  try {
    ssh.connect({
      host: '127.0.0.1',
      port: (server.address() as { port: number }).port,
      username: 'fixture',
      password: 'fixture',
      hostVerifier: () => true
    })
    await once(ssh, 'ready')
    expect(
      await executeDiagnostic(ssh, 'approved fixture', new AbortController().signal)
    ).toMatchObject({
      stdout: 'disk sample\n',
      stderr: 'fixture warning\n',
      exitCode: 7,
      outcome: 'completed'
    })
    expect(
      await executeDiagnostic(ssh, 'stalled', new AbortController().signal, 150)
    ).toMatchObject({ outcome: 'timeout' })
    expect(commands).toEqual(['approved fixture', 'stalled'])
  } finally {
    ssh.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 10000)
