import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs'
import { readFileSync } from 'fs'
import { userInfo } from 'os'
import { join } from 'path'
import type { Readable } from 'stream'
import { app, BrowserWindow } from 'electron'
import type {
  Credential,
  SessionGroup,
  SessionProfile,
  QuickConnectParams,
  ResolvedAuth
} from '../../shared/types'
import { inheritedFrom, resolveAuth as resolveAuthChain } from '../../shared/authResolution'
import { applyCredential } from '../../shared/credentials'
import { IPC } from '../../shared/ipc-channels'
import { OSC7_SHELL_SETUP, scanOsc7 } from '../../shared/osc7'
import { EchoSuppressor } from './echoSuppressor'
import { sessionStore } from '../store/SessionStore'
import { gitFolderStore } from '../gitFolders/GitFolderStore'
import { inventoryStore } from '../inventory/InventoryStore'
import { vault } from '../vault/Vault'
import { makeHostVerifier } from './hostVerifier'
import { requireUnlocked } from '../vault/locked'
import { requestAuth } from './authPrompt'

interface LiveConnection {
  fileAccess?: import('../../shared/types').FileAccess
  id: string
  clients: Client[] // chain of clients, last one is the target
  stream: ClientChannel
  logStream?: WriteStream
  /** Output held back for the next flush, and how much of it there is. */
  outbox: Buffer[]
  outboxBytes: number
  flushTimer?: NodeJS.Timeout
  /** Sent to the renderer and not yet reported as written to the terminal. */
  inFlight: number
  /** Whether the far end has been told to stop talking for a moment. */
  paused: boolean
  /**
   * Whether this connection's directory is being tracked. Held per connection
   * rather than read from the profile each time, so it can be switched from the
   * SFTP panel without editing — and un-editing — the saved host.
   */
  followCwd: boolean
  /** Swallows the echo of the setup line we typed in, so it never shows. */
  echoSuppressor?: EchoSuppressor
  /**
   * Set while the setup line is waiting for the shell to stop talking, with
   * the means to put the wait off again when it has not.
   */
  setupWait?: { timer: NodeJS.Timeout; restart: () => void }
  /**
   * Whether the window has said it is listening on this connection's channels.
   *
   * Nothing is sent before it does. The renderer cannot subscribe until it
   * knows the id, and it only learns the id when `connect` resolves — so every
   * message sent in between was addressed to a channel nobody was on, and
   * Electron drops those without a word. The shell's greeting went that way
   * sometimes; a tunnel that failed to come up went that way *always*, since
   * that message is sent while `connect` is still working.
   */
  ready: boolean
  /** What was said before anybody was listening, in the order it was said. */
  pending: { channel: string; payload: unknown }[]
  /** Gives up waiting, in case a window never speaks. */
  readyTimer?: NodeJS.Timeout
}

const OPENSSH_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'

/**
 * How long output is allowed to sit before it is handed to the renderer.
 *
 * A busy shell emits dozens of small chunks a second, and one IPC message each
 * costs more than the bytes do. Eight milliseconds is under half a frame, so a
 * keystroke echo still arrives on the next paint, while `cat` on a large file
 * becomes a handful of large writes instead of thousands of small ones.
 */
/**
 * How long a connection holds its first words for a window that has not spoken.
 *
 * Generous on purpose: the cost of waiting is a greeting that arrives late, and
 * the cost of not waiting is one that never arrives at all.
 */
const READY_GRACE_MS = 5000

const FLUSH_INTERVAL_MS = 8

/** Enough held up already: send it now rather than waiting out the interval. */
const FLUSH_BYTES = 64 * 1024

/**
 * How far the renderer may fall behind before the host is asked to pause.
 *
 * Without this, output the terminal cannot keep up with simply accumulates —
 * `cat /dev/urandom` grows the renderer's queue until something gives. Pausing
 * the stream propagates through SSH's own window as backpressure, so the far
 * end stops sending rather than this end stopping reading.
 */
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 256 * 1024

/**
 * How long the shell has to stay quiet before the setup line is typed in.
 *
 * Typing it the instant the channel opens looked simplest and was wrong. A
 * login shell that is still working through `/etc/profile` has not started its
 * line editor yet, so the tty driver echoes the line straight back into the
 * middle of the banner — and the editor then draws it a second time once the
 * prompt appears. Worse, anything in the profile that reads from the terminal
 * would eat the line instead of the shell running it.
 *
 * Waiting for a pause means the line goes to a shell sitting at its prompt,
 * where it is echoed once, in one piece, and can be taken back out cleanly.
 */
const SETUP_QUIET_MS = 400

/** A host that never stops talking still gets the line, just late. */
const SETUP_WAIT_CAP_MS = 5000

/**
 * Locates an SSH agent. An explicit SSH_AUTH_SOCK always wins. On Windows the
 * built-in OpenSSH agent listens on a named pipe and is now the common case, so
 * it is preferred over Pageant, which is only used if that pipe is absent.
 */
function agentSockForPlatform(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform !== 'win32') return undefined
  return existsSync(OPENSSH_PIPE) ? OPENSSH_PIPE : 'pageant'
}

/**
 * Collapses a profile's own settings with everything inherited from its groups.
 *
 * A login that is set nowhere — not on the host, not on any group above it —
 * means the account you are logged in as here, which is what `ssh somehost`
 * does and what people expect from it. Before this it meant an empty user name
 * handed to the server, which is a refused connection and a puzzling one; the
 * host dialog worked around it by refusing to save a host until a login was
 * typed, even when the whole point was to inherit one.
 */
function effectiveAuth(profile: SessionProfile): ResolvedAuth {
  const auth = resolveAuthChain(profile, profile.groupId, everyGroup())
  return auth.username ? auth : { ...auth, username: userInfo().username }
}

/**
 * Every group a host can inherit from — the saved ones, an Inventory source's,
 * and those a Sessions folder mirrors out of git.
 */
function everyGroup(): SessionGroup[] {
  return [
    ...sessionStore.getAll().groups,
    ...inventoryStore.allGroups(),
    ...gitFolderStore.allGroups()
  ]
}

/**
 * What a host was signed in with, in words.
 *
 * A refused login is the one failure where "what did it even try?" is the whole
 * question, and the answer is regularly "a password you have never typed for
 * this machine": a blank field inherits, so a host sitting in a group is
 * offered that group's password without anything on screen saying so. Through a
 * jump host it is worse still, since two machines authenticate separately and
 * the error names neither.
 */
function credentialSource(profile: SessionProfile, auth: ResolvedAuth): string {
  if (auth.authMethod === 'agent') return 'the SSH agent'
  if (auth.authMethod === 'privateKey') {
    const from = inheritedFrom(profile, profile.groupId, everyGroup(), 'privateKeyPath')
    const key = auth.privateKeyPath ?? 'no key file'
    return from ? `the key ${key}, from the group ${from.name}` : `the key ${key}`
  }
  if (!auth.secretRef) return 'the password you typed'
  const from = inheritedFrom(profile, profile.groupId, everyGroup(), 'secretRef')
  return from ? `the password saved on the group ${from.name}` : 'the password saved on this host'
}

/**
 * Watches the handshake for the one thing the failure never says: which ways of
 * signing in the server is prepared to accept.
 *
 * A refusal has two quite different causes that look identical from here — the
 * password was wrong, or the server never wanted a password at all — and only
 * the second is worth changing settings over. The server states this on every
 * rejection, in a line ssh2 writes to its debug channel and nowhere else:
 * "Received USERAUTH_FAILURE, continue with: publickey,keyboard-interactive".
 *
 * So the channel is read, for the length of the handshake only. It carries
 * every packet otherwise, which is not a thing to leave running on a live
 * session.
 */
function methodWatcher(): {
  debug: (message: string) => void
  stop: () => void
  seen: () => string | undefined
} {
  let methods: string | undefined
  let watching = true
  return {
    debug: (message) => {
      if (!watching) return
      const match = /continue with:?\s*(.+)/i.exec(message)
      if (match) methods = match[1].trim()
    },
    stop: () => {
      watching = false
    },
    seen: () => methods
  }
}

/**
 * The same failure, said in a way that names the machine that refused.
 *
 * ssh2 says "All configured authentication methods failed" and nothing else,
 * which in a chain does not even say which end refused — and that was the whole
 * of what a user saw.
 */
function hopFailure(
  err: Error,
  profile: SessionProfile,
  auth: ResolvedAuth,
  offered?: string
): Error {
  const who = `${auth.username}@${profile.host}`
  if (!/authentication methods failed/i.test(err.message)) {
    return new Error(`${profile.name} (${who}): ${err.message}`)
  }
  const tried = `It was offered ${credentialSource(profile, auth)}`
  /*
   * When the server has said what it accepts, that is the whole answer and it
   * goes first: a host that does not list `password` will never take one
   * however many times it is retyped, and nothing on this end could have shown
   * that before.
   */
  const accepts = offered
    ? `, while the server accepts: ${offered}.`
    : `. If that is not what this machine wants, set the login and password on the host itself rather than inheriting them.`
  return new Error(`${profile.name} refused to sign in as ${who}. ${tried}${accepts}`)
}

async function buildAuthConfig(
  win: BrowserWindow,
  profile: SessionProfile,
  auth: ResolvedAuth
): Promise<
  Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent' | 'agentForward'>
> {
  if (auth.authMethod === 'password') {
    let password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    if (!password) {
      // Nothing stored: ask, rather than failing authentication silently. This
      // is also the path for people who deliberately don't save passwords.
      const answers = await requestAuth(win, {
        host: `${auth.username}@${profile.host}`,
        title: 'Password required',
        fields: [{ prompt: 'Password', echo: false }]
      })
      if (!answers) throw new Error('Authentication cancelled')
      password = answers[0]
    }
    return { password, ...forwarding(auth) }
  }
  if (auth.authMethod === 'privateKey') {
    if (!auth.privateKeyPath) throw new Error('No private key path configured')
    const privateKey = readFileSync(auth.privateKeyPath)
    const passphrase = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    return { privateKey, passphrase, ...forwarding(auth) }
  }
  // agent
  return { agent: agentSockForPlatform(), agentForward: auth.agentForward }
}

/**
 * Agent forwarding for a host that signs in some other way.
 *
 * How you prove who you are and whether your agent travels with you are two
 * different questions, and OpenSSH treats them as two: `ForwardAgent yes` works
 * whether you typed a password or offered a key. This end used to answer both
 * at once — the flag was attached only to the agent branch, so a host set to
 * password authentication showed the checkbox, remembered it, and forwarded
 * nothing.
 *
 * ssh2 needs the socket named before it will forward it, hence both fields. It
 * will now offer the agent's keys before falling back to the password, which is
 * also what `ssh` does with an agent loaded — and only for hosts where somebody
 * asked for this.
 */
export function forwarding(auth: ResolvedAuth): { agent?: string; agentForward?: boolean } {
  if (!auth.agentForward) return {}
  const agent = agentSockForPlatform()
  return agent ? { agent, agentForward: true } : {}
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
        // ssh2 leaves echo optional; a prompt that doesn't say otherwise is a
        // secret, so it must be masked rather than shown.
        fields: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true }))
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

/**
 * Connects to `profile`, hopping through its jump-host chain if configured.
 * Resolves with the final connected Client and the list of every client opened
 * along the way (for cleanup).
 *
 * A chosen account applies to the destination and to nothing else. The machines
 * in between are somebody's jump hosts, reached as whoever they are configured
 * to be reached as — connecting to a server as a domain administrator says
 * nothing about who you are on the bastion you pass through, and offering that
 * account there would mostly fail, sometimes lock it out, and never be what was
 * asked for.
 */
async function connectChain(
  win: BrowserWindow,
  profile: SessionProfile,
  credential?: Credential
): Promise<{ target: Client; chain: Client[] }> {
  // Each hop carries its own inherited settings, resolved once up front.
  const hops: Array<{ profile: SessionProfile; auth: ResolvedAuth }> = []
  let cursor: SessionProfile | undefined = profile
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    /*
     * The first turn of this loop is the destination itself; every later one is
     * a hop on the way to it.
     *
     * The annotation is not decoration. Comparing `cursor` against `profile`
     * makes this line depend on `cursor`'s narrowed type, which is decided by
     * the assignment at the foot of the loop — which reads `auth`, which is
     * this line. Stating the type breaks the circle; without it the compiler
     * gives up and calls `auth` an `any`.
     */
    const auth: ResolvedAuth =
      cursor === profile
        ? applyCredential(effectiveAuth(cursor), credential)
        : effectiveAuth(cursor)
    hops.unshift({ profile: cursor, auth })
    cursor = auth.jumpHostId
      ? sessionStore.getAll().sessions.find((s) => s.id === auth.jumpHostId)
      : undefined
  }

  const chain: Client[] = []
  let sock: Readable | undefined

  for (let i = 0; i < hops.length; i++) {
    const { profile: hop, auth } = hops[i]
    const client = new Client()
    chain.push(client)
    const authConfig = await buildAuthConfig(win, hop, auth)
    wireKeyboardInteractive(win, client, `${auth.username}@${hop.host}`)
    const methods = methodWatcher()
    await new Promise<void>((resolve, reject) => {
      client.on('ready', () => {
        methods.stop()
        resolve()
      })
      // Which machine, as whom, with what, and what it would have taken instead
      // — none of which ssh2's own message carries, and all of which decide
      // what to do about it.
      client.on('error', (err) => {
        methods.stop()
        reject(hopFailure(err as Error, hop, auth, methods.seen()))
      })
      client.connect({
        ...COMMON_CONNECT,
        debug: methods.debug,
        host: hop.host,
        port: auth.port,
        username: auth.username,
        hostVerifier: makeHostVerifier(win, hop.host, auth.port),
        ...authConfig,
        ...(sock ? { sock } : {})
      })
    })

    const isLast = i === hops.length - 1
    if (!isLast) {
      const nextHop = hops[i + 1]
      sock = await new Promise<Readable>((resolve, reject) => {
        client.forwardOut(
          '127.0.0.1',
          0,
          nextHop.profile.host,
          nextHop.auth.port,
          (err, stream) => {
            if (err) reject(err)
            else resolve(stream as unknown as Readable)
          }
        )
      })
    }
  }

  return { target: chain[chain.length - 1], chain }
}

class SSHManager {
  private connections = new Map<string, LiveConnection>()

  private send(win: BrowserWindow, connectionId: string, channel: string, payload: unknown): void {
    if (win.isDestroyed()) return
    const conn = this.connections.get(connectionId)
    if (conn && !conn.ready) {
      conn.pending.push({ channel, payload })
      return
    }
    win.webContents.send(`${channel}:${connectionId}`, payload)
  }

  /**
   * The window has subscribed; everything held for it goes now, in order.
   *
   * Called again for a connection already running is a no-op, and called for
   * one that has already closed still delivers — what it held is the reason it
   * closed, which is the most useful thing it ever had to say.
   */
  markReady(win: BrowserWindow, connectionId: string): void {
    const conn = this.connections.get(connectionId) ?? this.closing.get(connectionId)
    if (!conn || conn.ready) return
    if (conn.readyTimer) clearTimeout(conn.readyTimer)
    conn.readyTimer = undefined
    conn.ready = true
    const held = conn.pending
    conn.pending = []
    if (win.isDestroyed()) return
    for (const { channel, payload } of held) {
      win.webContents.send(`${channel}:${connectionId}`, payload)
    }
    this.closing.delete(connectionId)
  }

  /**
   * Connections that have ended with something still unsaid.
   *
   * A session can fail before the window ever subscribes — a refused tunnel on
   * a host that then drops, say — and `teardown` would take the explanation
   * with it. Held here until the window asks, and dropped either way once it
   * does.
   */
  private closing = new Map<string, LiveConnection>()

  /** Holds output for a few milliseconds so a burst travels as one message. */
  private queueOutput(win: BrowserWindow, conn: LiveConnection, data: Buffer): void {
    conn.outbox.push(data)
    conn.outboxBytes += data.length
    if (conn.outboxBytes >= FLUSH_BYTES) {
      this.flushOutput(win, conn)
      return
    }
    if (!conn.flushTimer) {
      conn.flushTimer = setTimeout(() => this.flushOutput(win, conn), FLUSH_INTERVAL_MS)
    }
  }

  /**
   * Hands everything held to the renderer as one message.
   *
   * The bytes travel as a `Buffer`, which arrives the other side as a
   * `Uint8Array` and goes straight into `term.write`. They used to be base64: a
   * third more bytes across the boundary, and a per-byte `charCodeAt` loop in
   * the renderer to undo it.
   */
  private flushOutput(win: BrowserWindow, conn: LiveConnection): void {
    if (conn.flushTimer) {
      clearTimeout(conn.flushTimer)
      conn.flushTimer = undefined
    }
    if (conn.outboxBytes === 0) return

    const payload =
      conn.outbox.length === 1 ? conn.outbox[0] : Buffer.concat(conn.outbox, conn.outboxBytes)
    conn.outbox = []
    conn.outboxBytes = 0

    conn.inFlight += payload.length
    this.send(win, conn.id, IPC.sshData, payload)

    if (!conn.paused && conn.inFlight >= HIGH_WATER) {
      conn.paused = true
      // Both halves: stderr is a readable of its own on the same channel, and a
      // build pouring warnings out of it floods just as well as stdout does.
      conn.stream.pause()
      conn.stream.stderr.pause()
    }
  }

  /**
   * The renderer reporting that a chunk has reached the terminal.
   *
   * This is the only thing that lets a paused connection start again, so it has
   * to be sent for every chunk received — see TerminalHost. A pane that stops
   * acknowledging is one that is being torn down, and the connection goes with
   * it.
   */
  acknowledge(connectionId: string, bytes: number): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    conn.inFlight = Math.max(0, conn.inFlight - bytes)
    if (conn.paused && conn.inFlight <= LOW_WATER) {
      conn.paused = false
      conn.stream.resume()
      conn.stream.stderr.resume()
    }
  }

  /**
   * Opening a session is one of the things a locked vault must refuse. A host
   * that signs in by key or through the agent never asks the vault for
   * anything, so without this the lock did not stand between anybody and the
   * machines at all — see `vault/locked.ts`.
   */
  async connectProfile(
    win: BrowserWindow,
    profile: SessionProfile,
    cols: number,
    rows: number,
    /** A login chosen for this session alone, in place of the host's own. */
    credential?: Credential
  ): Promise<string> {
    requireUnlocked()
    const connectionId = randomUUID()
    try {
      const { target, chain } = await connectChain(win, profile, credential)
      await this.openShell(win, connectionId, target, chain, cols, rows, profile)
      return connectionId
    } catch (err) {
      this.send(win, connectionId, IPC.sshError, (err as Error).message)
      throw err
    }
  }

  /** The same for a connection typed in by hand rather than saved. */
  async connectQuick(
    win: BrowserWindow,
    params: QuickConnectParams,
    cols: number,
    rows: number
  ): Promise<string> {
    requireUnlocked()
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

        const auth = profile ? effectiveAuth(profile) : undefined
        // The saved setting is only the starting point; the SFTP panel can turn
        // it on and off afterwards. Scanning is skipped entirely while it is off.
        const connection: LiveConnection = {
          fileAccess: auth?.fileAccess,
          id: connectionId,
          clients: chain,
          stream,
          logStream,
          followCwd: auth?.followTerminalCwd === true,
          outbox: [],
          outboxBytes: 0,
          inFlight: 0,
          paused: false,
          ready: false,
          pending: []
        }
        /*
         * A window that never subscribes must not silence a session for good.
         * The renderer does it within a round trip of learning the id, so this
         * is only ever reached by one that crashed, was replaced mid-connect,
         * or belongs to a build that predates the handshake.
         */
        connection.readyTimer = setTimeout(() => this.markReady(win, connectionId), READY_GRACE_MS)
        connection.readyTimer.unref?.()
        this.connections.set(connectionId, connection)

        let pending = ''
        let lastCwd: string | undefined

        stream.on('data', (raw: Buffer) => {
          // Still mid-login, or mid-anything: the setup line can wait.
          connection.setupWait?.restart()
          // The setup line is ours, not the user's, so its echo is taken back
          // out before anyone sees it. Scanning still runs on the full stream:
          // the sequence we are looking for rides in that same echo.
          const suppressor = connection.echoSuppressor
          const data = suppressor && !suppressor.done ? suppressor.push(raw) : raw

          if (data.length > 0) {
            this.queueOutput(win, connection, data)
            logStream?.write(data)
          }
          if (!connection.followCwd) return
          const scan = scanOsc7(pending + raw.toString('utf8'))
          pending = scan.rest
          if (scan.path && scan.path !== lastCwd) {
            lastCwd = scan.path
            this.send(win, connectionId, IPC.sshCwd, scan.path)
          }
        })
        stream.stderr.on('data', (data: Buffer) => {
          this.queueOutput(win, connection, data)
        })
        stream.on('close', () => {
          // Whatever is still held back is the last thing the host said — an
          // error message, usually. Flushed before the status, so a connection
          // that ends inside a flush interval does not take it with it.
          this.flushOutput(win, connection)
          this.send(win, connectionId, IPC.sshStatus, 'closed')
          this.teardown(connectionId)
        })
        target.on('error', (e) => {
          this.send(win, connectionId, IPC.sshError, e.message)
        })

        this.send(win, connectionId, IPC.sshStatus, 'connected')

        // Typed in rather than run on a separate exec channel, so the command
        // and its output show up in the terminal, `cd` sticks, and `sudo -i`
        // hands over the session the user is looking at. A reconnect repeats it.
        // The shell only reports its directory if it has been told to. Sent as
        // one line so the echo is a line rather than a screenful, and appended
        // to any PROMPT_COMMAND already there rather than replacing it.
        if (connection.followCwd) this.sendSetupQuietly(connection)

        if (auth) {
          const command = auth.onConnectCommand?.trim()
          if (command) {
            for (const line of command.split('\n')) stream.write(`${line}\n`)
          }
        }

        resolve()
      })
    })
  }

  /**
   * Waits for the shell to draw breath, then types the setup line in.
   *
   * The wait is pushed back by every chunk that arrives, so a long banner or a
   * slow profile simply delays it, up to a cap past which the line is sent
   * anyway rather than never.
   */
  private sendSetupQuietly(conn: LiveConnection): void {
    if (conn.setupWait) return
    const deadline = Date.now() + SETUP_WAIT_CAP_MS
    const fire = (): void => {
      conn.setupWait = undefined
      this.writeSetup(conn)
    }
    const restart = (): void => {
      const wait = conn.setupWait
      if (!wait) return
      clearTimeout(wait.timer)
      wait.timer = setTimeout(fire, Math.max(0, Math.min(SETUP_QUIET_MS, deadline - Date.now())))
    }
    conn.setupWait = { timer: setTimeout(fire, SETUP_QUIET_MS), restart }
  }

  /**
   * Types the setup line in without showing it. If the shell never echoes it —
   * echo disabled, or a shell that swallows it — the suppressor is released
   * shortly after, so nothing of the user's is held back for long.
   */
  private writeSetup(conn: LiveConnection): void {
    const line = `${OSC7_SHELL_SETUP}\n`
    conn.echoSuppressor = new EchoSuppressor(Buffer.from(OSC7_SHELL_SETUP, 'utf8'))
    conn.stream.write(line)
    setTimeout(() => {
      const held = conn.echoSuppressor?.done === false ? conn.echoSuppressor.flush() : undefined
      if (held && held.length > 0) {
        const win = BrowserWindow.getAllWindows()[0]
        if (win && !win.isDestroyed()) this.queueOutput(win, conn, held)
      }
    }, 2000)
  }

  /**
   * Turns directory tracking on or off for a live connection.
   *
   * Enabling sends the setup line again, which is what makes this work on a
   * host that was never configured for it. Disabling only stops listening: the
   * shell keeps printing an escape sequence nobody reads, which is invisible
   * and harmless, and undoing it would mean issuing more commands.
   */
  setFollowCwd(connectionId: string, enabled: boolean): boolean {
    const conn = this.connections.get(connectionId)
    if (!conn) return false
    if (enabled && !conn.followCwd) this.sendSetupQuietly(conn)
    conn.followCwd = enabled
    return conn.followCwd
  }

  isFollowingCwd(connectionId: string): boolean {
    return this.connections.get(connectionId)?.followCwd ?? false
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

  getFileAccess(connectionId: string): import('../../shared/types').FileAccess | undefined {
    return this.connections.get(connectionId)?.fileAccess
  }

  getClientChain(connectionId: string): Client[] | undefined {
    return this.connections.get(connectionId)?.clients
  }

  /**
   * Runs a command on its own channel and returns what it printed.
   *
   * Deliberately not the shell: anything written there is the user's session,
   * and a background poll typing into it would scroll their terminal and land
   * in their history. stderr is dropped — callers here probe for files that
   * may not exist, and a complaint about one is not a failure of the whole.
   */
  exec(connectionId: string, command: string, timeoutMs = 10_000): Promise<string> {
    const chain = this.connections.get(connectionId)?.clients
    if (!chain || chain.length === 0) return Promise.reject(new Error('No active SSH connection'))
    const target = chain[chain.length - 1]

    return new Promise((resolve, reject) => {
      target.exec(command, (err, stream) => {
        if (err) {
          reject(err)
          return
        }
        let out = ''
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          fn()
        }
        // A host that accepts the channel and then says nothing must not leave
        // a poll pending for ever.
        const timer = setTimeout(() => {
          finish(() => {
            try {
              stream.close()
            } catch {
              /* already gone */
            }
            reject(new Error('Timed out'))
          })
        }, timeoutMs)

        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
        })
        stream.stderr.resume()
        stream.on('close', () => finish(() => resolve(out)))
        stream.on('error', (streamErr: Error) => finish(() => reject(streamErr)))
      })
    })
  }

  private teardown(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return
    /*
     * Announced before anything is closed, so whatever runs here still sees a
     * connection it can work with — the SFTP channels, the port forwards, the
     * remote edits and the monitor are all released this way, and they were
     * released only when somebody closed the pane by hand. A shell that ended
     * on its own — `exit`, or a dropped link — left every one of them behind,
     * and a forwarded port left listening is one nothing can bind again.
     */
    for (const watcher of this.closedWatchers) watcher(connectionId)
    if (conn.flushTimer) clearTimeout(conn.flushTimer)
    if (conn.setupWait) clearTimeout(conn.setupWait.timer)
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
    // Kept only if it never got to speak; `markReady` drops it either way.
    if (!conn.ready && conn.pending.length > 0) this.closing.set(connectionId, conn)
    else if (conn.readyTimer) clearTimeout(conn.readyTimer)
  }

  private closedWatchers: ((connectionId: string) => void)[] = []

  /**
   * Told whenever a connection ends, however it ended.
   *
   * An observer rather than a call into the managers that need to know:
   * `PortForwardManager` and the SFTP side already import this one, and
   * importing them back would be a cycle. The wiring lives in `ipc/ssh.ts`,
   * where the explicit disconnect is handled, so both routes out of a session
   * run the same cleanup.
   */
  onClosed(watcher: (connectionId: string) => void): void {
    this.closedWatchers.push(watcher)
  }
}

export const sshManager = new SSHManager()
export { connectChain }
