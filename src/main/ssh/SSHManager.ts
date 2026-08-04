import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { Readable } from 'stream'
import { app, BrowserWindow } from 'electron'
import type { SessionProfile, QuickConnectParams } from '../../shared/types'
import { IPC } from '../../shared/ipc-channels'
import { sessionStore } from '../store/SessionStore'
import { vault } from '../vault/Vault'
import { makeHostVerifier } from './hostVerifier'
import { requestAuth } from './authPrompt'

interface LiveConnection {
  id: string
  clients: Client[] // chain of clients, last one is the target
  stream: ClientChannel
  logStream?: WriteStream
}

function agentSockForPlatform(): string | undefined {
  if (process.platform === 'win32') return 'pageant'
  return process.env.SSH_AUTH_SOCK
}

async function resolveAuth(
  win: BrowserWindow,
  profile: SessionProfile
): Promise<
  Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent' | 'agentForward'>
> {
  if (profile.authMethod === 'password') {
    let password = profile.secretRef ? vault.getSecret(profile.secretRef) : undefined
    if (!password) {
      // Nothing stored: ask, rather than failing authentication silently. This
      // is also the path for people who deliberately don't save passwords.
      const answers = await requestAuth(win, {
        host: `${profile.username}@${profile.host}`,
        title: 'Password required',
        fields: [{ prompt: 'Password', echo: false }]
      })
      if (!answers) throw new Error('Authentication cancelled')
      password = answers[0]
    }
    return { password }
  }
  if (profile.authMethod === 'privateKey') {
    if (!profile.privateKeyPath) throw new Error('No private key path configured')
    const privateKey = readFileSync(profile.privateKeyPath)
    const passphrase = profile.secretRef ? vault.getSecret(profile.secretRef) : undefined
    return { privateKey, passphrase }
  }
  // agent
  return { agent: agentSockForPlatform(), agentForward: profile.agentForward }
}

/**
 * Answers keyboard-interactive challenges — the mechanism PAM and 2FA prompts
 * (Google Authenticator, Duo) arrive through. Without this such hosts simply
 * cannot be reached.
 */
function wireKeyboardInteractive(win: BrowserWindow, client: Client, host: string): void {
  client.on(
    'keyboard-interactive',
    (name, instructions, _lang, prompts, finish: (answers: string[]) => void) => {
      requestAuth(win, {
        host,
        title: name || 'Additional authentication',
        instructions,
        fields: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo }))
      }).then((answers) => finish(answers ?? []))
    }
  )
}

/** Shared connect options: keepalive stops idle sessions dying behind NAT. */
const COMMON_CONNECT: Partial<ConnectConfig> = {
  // Generous: the handshake pauses while the user reads a host-key prompt or
  // types a 2FA code.
  readyTimeout: 120000,
  keepaliveInterval: 20000,
  keepaliveCountMax: 3,
  tryKeyboard: true
}

/** Connects to `profile`, hopping through its jump-host chain if configured. Resolves with the final connected Client and the list of every client opened along the way (for cleanup). */
async function connectChain(
  win: BrowserWindow,
  profile: SessionProfile
): Promise<{ target: Client; chain: Client[] }> {
  const hops: SessionProfile[] = [profile]
  let cursor = profile
  while (cursor.jumpHostId) {
    const next = sessionStore.getAll().sessions.find((s) => s.id === cursor.jumpHostId)
    if (!next) break
    hops.unshift(next)
    cursor = next
  }

  const chain: Client[] = []
  let sock: Readable | undefined

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]
    const client = new Client()
    chain.push(client)
    const auth = await resolveAuth(win, hop)
    wireKeyboardInteractive(win, client, `${hop.username}@${hop.host}`)
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => resolve())
      client.on('error', (err) => reject(err))
      client.connect({
        ...COMMON_CONNECT,
        host: hop.host,
        port: hop.port,
        username: hop.username,
        hostVerifier: makeHostVerifier(win, hop.host, hop.port),
        ...auth,
        ...(sock ? { sock } : {})
      })
    })

    const isLast = i === hops.length - 1
    if (!isLast) {
      const nextHop = hops[i + 1]
      sock = await new Promise<Readable>((resolve, reject) => {
        client.forwardOut('127.0.0.1', 0, nextHop.host, nextHop.port, (err, stream) => {
          if (err) reject(err)
          else resolve(stream as unknown as Readable)
        })
      })
    }
  }

  return { target: chain[chain.length - 1], chain }
}

class SSHManager {
  private connections = new Map<string, LiveConnection>()

  private send(win: BrowserWindow, connectionId: string, channel: string, payload: unknown): void {
    if (win.isDestroyed()) return
    win.webContents.send(`${channel}:${connectionId}`, payload)
  }

  async connectProfile(
    win: BrowserWindow,
    profile: SessionProfile,
    cols: number,
    rows: number
  ): Promise<string> {
    const connectionId = randomUUID()
    try {
      const { target, chain } = await connectChain(win, profile)
      await this.openShell(win, connectionId, target, chain, cols, rows, profile)
      return connectionId
    } catch (err) {
      this.send(win, connectionId, IPC.sshError, (err as Error).message)
      throw err
    }
  }

  async connectQuick(
    win: BrowserWindow,
    params: QuickConnectParams,
    cols: number,
    rows: number
  ): Promise<string> {
    const connectionId = randomUUID()
    try {
      const client = new Client()
      const auth: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent'> =
        params.authMethod === 'password'
          ? { password: params.password }
          : params.authMethod === 'privateKey'
            ? {
                privateKey: params.privateKeyPath ? readFileSync(params.privateKeyPath) : undefined,
                passphrase: params.passphrase
              }
            : { agent: agentSockForPlatform() }

      wireKeyboardInteractive(win, client, `${params.username}@${params.host}`)
      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve())
        client.on('error', (err) => reject(err))
        client.connect({
          ...COMMON_CONNECT,
          host: params.host,
          port: params.port,
          username: params.username,
          hostVerifier: makeHostVerifier(win, params.host, params.port),
          ...auth
        })
      })

      await this.openShell(win, connectionId, client, [client], cols, rows)
      return connectionId
    } catch (err) {
      this.send(win, connectionId, IPC.sshError, (err as Error).message)
      throw err
    }
  }

  private openShell(
    win: BrowserWindow,
    connectionId: string,
    target: Client,
    chain: Client[],
    cols: number,
    rows: number,
    profile?: SessionProfile
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      target.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        let logStream: WriteStream | undefined
        if (profile?.logToFile) {
          const dir = join(app.getPath('userData'), 'logs')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          const filename = `${profile.name.replace(/[^a-z0-9-_]+/gi, '_')}_${Date.now()}.log`
          logStream = createWriteStream(join(dir, filename), { flags: 'a' })
        }

        this.connections.set(connectionId, { id: connectionId, clients: chain, stream, logStream })

        stream.on('data', (data: Buffer) => {
          this.send(win, connectionId, IPC.sshData, data.toString('base64'))
          logStream?.write(data)
        })
        stream.stderr.on('data', (data: Buffer) => {
          this.send(win, connectionId, IPC.sshData, data.toString('base64'))
        })
        stream.on('close', () => {
          this.send(win, connectionId, IPC.sshStatus, 'closed')
          this.teardown(connectionId)
        })
        target.on('error', (e) => {
          this.send(win, connectionId, IPC.sshError, e.message)
        })

        this.send(win, connectionId, IPC.sshStatus, 'connected')
        resolve()
      })
    })
  }

  write(connectionId: string, data: string): void {
    this.connections.get(connectionId)?.stream.write(data)
  }

  resize(connectionId: string, cols: number, rows: number): void {
    this.connections.get(connectionId)?.stream.setWindow(rows, cols, 0, 0)
  }

  disconnect(connectionId: string): void {
    this.teardown(connectionId)
  }

  getClientChain(connectionId: string): Client[] | undefined {
    return this.connections.get(connectionId)?.clients
  }

  private teardown(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    conn.logStream?.end()
    try {
      conn.stream.close()
    } catch {
      /* already closed */
    }
    for (const client of conn.clients) {
      try {
        client.end()
      } catch {
        /* already closed */
      }
    }
    this.connections.delete(connectionId)
  }
}

export const sshManager = new SSHManager()
export { connectChain }
