import { Client, type ConnectConfig, type ClientChannel } from 'ssh2'
import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'fs'
import { userInfo } from 'os'
import { join } from 'path'
import { StringDecoder } from 'string_decoder'
import type { Readable } from 'stream'
import { app, BrowserWindow } from 'electron'
import type {
  Credential,
  SessionProfile,
  QuickConnectParams,
  ResolvedAuth
} from '../../shared/types'
import { inheritedFrom, resolveAuth as resolveAuthChain } from '../../shared/authResolution'
import { applyCredential } from '../../shared/credentials'
import { IPC } from '../../shared/ipc-channels'
import { OSC7_SHELL_SETUP, scanOsc7 } from '../../shared/osc7'
import { EchoSuppressor } from './echoSuppressor'
import { everyGroup, findProfile } from '../store/hosts'
import { vault } from '../vault/Vault'
import { makeHostVerifier } from './hostVerifier'
import { requireUnlocked } from '../vault/locked'
import { requestAuth } from './authPrompt'
import { readPrivateKey } from './ppk'
import { diag } from '../diagnostics'
import { describeInput } from '../../shared/diagnostics'

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
 * How long a connection holds its first words for a window that has not spoken.
 *
 * Generous on purpose: the cost of waiting is a greeting that arrives late, and
 * the cost of not waiting is one that never arrives at all.
 */
const READY_GRACE_MS = 5000

/**
 * How long output is allowed to sit before it is handed to the renderer.
 *
 * A busy shell emits dozens of small chunks a second, and one IPC message each
 * costs more than the bytes do. Eight milliseconds is under half a frame, so a
 * keystroke echo still arrives on the next paint, while `cat` on a large file
 * becomes a handful of large writes instead of thousands of small ones.
 */
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
 * "Inbound: Received USERAUTH_FAILURE (publickey,keyboard-interactive)".
 *
 * It was looked for as "continue with: …", which is not how ssh2 words it, so
 * the hint never appeared and every refusal ended in advice about inherited
 * passwords — given to someone who had offered a key and no password at all.
 *
 * So the channel is read, for the length of the handshake only. It carries
 * every packet otherwise, which is not a thing to leave running on a live
 * session.
 *
 * The sign-in itself goes into the diagnostics journal on the way past: the
 * server's version, each method tried and each answer, partial successes
 * included. A key PuTTY gets in with and this refuses is otherwise a guess —
 * the failure says only that nothing worked. These lines name methods and
 * message types, never a password, a key or anything typed.
 */
const SIGN_IN_TRACE =
  /^(Remote ident|Inbound: Received USERAUTH|Outbound: Sending USERAUTH|Client: |Handshake completed)/

export function methodWatcher(label = ''): {
  debug: (message: string) => void
  stop: () => void
  seen: () => string | undefined
} {
  let methods: string | undefined
  let watching = true
  return {
    debug: (message) => {
      if (!watching) return
      if (label && SIGN_IN_TRACE.test(message)) diag('ssh', `${label} ${message}`)
      const match = /USERAUTH_FAILURE \(([^)]*)\)/.exec(message)
      if (match?.[1]) methods = match[1].split(',').join(', ')
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
  /*
   * A key turned down by a server that takes keys is not a question of method:
   * this key is simply not one the server knows for that login. Saying so saves
   * a round of changing settings that were never the problem.
   */
  const unknownKey =
    auth.authMethod === 'privateKey' && offered && /\bpublickey\b/.test(offered)
      ? ` The key itself was refused: its public half is not in ~/.ssh/authorized_keys for ${auth.username} on that machine, or the key belongs to another login.`
      : ''
  return new Error(`${profile.name} refused to sign in as ${who}. ${tried}${accepts}${unknownKey}`)
}

async function buildAuthConfig(
  win: BrowserWindow,
  profile: SessionProfile,
  auth: ResolvedAuth,
  signal?: AbortSignal
): Promise<
  Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent' | 'agentForward'>
> {
  if (auth.authMethod === 'password') {
    let password = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    if (!password) {
      // Nothing stored: ask, rather than failing authentication silently. This
      // is also the path for people who deliberately don't save passwords.
      const answers = await requestAuth(
        win,
        {
          host: `${auth.username}@${profile.host}`,
          title: 'Password required',
          fields: [{ prompt: 'Password', echo: false }]
        },
        { signal }
      )
      if (signal?.aborted) throw new ConnectCancelledError()
      if (!answers) throw new Error('Authentication cancelled')
      password = answers[0]
    }
    return { password, ...forwarding(auth) }
  }
  if (auth.authMethod === 'privateKey') {
    if (!auth.privateKeyPath) throw new Error('No private key path configured')
    const passphrase = auth.secretRef ? vault.getSecret(auth.secretRef) : undefined
    return { ...(await readPrivateKey(auth.privateKeyPath, passphrase)), ...forwarding(auth) }
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
function wireKeyboardInteractive(
  win: BrowserWindow,
  client: Client,
  host: string,
  signal?: AbortSignal
): void {
  /*
   * A challenge outlives its client easily: the server gives up, the network
   * drops, the pane is closed. The dialog stayed up regardless, asking for a
   * code that nothing was waiting for — and with the renderer showing one
   * question at a time, it was in the way of the next real one.
   */
  const gone = new AbortController()
  const withdraw = (): void => gone.abort()
  client.on('close', withdraw)
  client.on('error', withdraw)
  signal?.addEventListener('abort', withdraw, { once: true })
  client.on(
    'keyboard-interactive',
    (name, instructions, _lang, prompts, finish: (answers: string[]) => void) => {
      requestAuth(
        win,
        {
          host,
          title: name || 'Additional authentication',
          instructions,
          // ssh2 leaves echo optional; a prompt that doesn't say otherwise is a
          // secret, so it must be masked rather than shown.
          fields: prompts.map((p) => ({ prompt: p.prompt, echo: p.echo === true }))
        },
        { signal: gone.signal }
      ).then((answers) => finish(answers ?? []))
    }
  )
}

/** A connection given up on before it was finished — by the pane, not the host. */
export class ConnectCancelledError extends Error {
  constructor() {
    super('Connection cancelled')
    this.name = 'ConnectCancelledError'
  }
}

/** Lets go of every client, whatever state each is in. */
function endClients(clients: Client[]): void {
  for (const client of clients) {
    try {
      client.end()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Connects one client and waits until it has signed in, failed, closed, or been
 * given up on — whichever comes first. The last two used to be missing: a
 * client ended from outside emitted `close` and no `error`, and the connect
 * waited for ever on a promise nothing would settle.
 */
function signIn(
  client: Client,
  config: ConnectConfig,
  signal: AbortSignal | undefined,
  describe: (err: Error) => Error,
  onSettled: () => void = () => undefined
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      onSettled()
      fn()
    }
    const onAbort = (): void => {
      settle(() => reject(new ConnectCancelledError()))
      endClients([client])
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.on('ready', () => settle(resolve))
    client.on('error', (err) => settle(() => reject(describe(err as Error))))
    client.on('close', () =>
      settle(() => reject(describe(new Error('the connection closed before signing in'))))
    )
    client.connect(config)
  })
}

/**
 * Waits for one callback from the far end — a forwarded channel, a shell —
 * and stops waiting when the connect is given up on or the far end takes too
 * long.
 *
 * Signing in could be cancelled, and everything after it could not. A bastion
 * that accepted the login and then never answered the request for a channel
 * held the connect open with nothing to end it: cancelling changed a flag
 * nobody was reading, and closing the pane or reloading the window left an
 * authenticated session behind. An answer that arrives after the wait is over
 * is not dropped on the floor either: whatever it opened is closed.
 */
export function answerOrGiveUp<T>(
  what: string,
  ask: (answer: (err: Error | undefined | null, value?: T) => void) => void,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  discard: (late: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let over = false
    const finish = (fn: () => void): void => {
      if (over) return
      over = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => finish(() => reject(new ConnectCancelledError()))
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`${what} did not answer in ${Math.round(timeoutMs / 1000)} s`))
        ),
      timeoutMs
    )
    timer.unref?.()
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    ask((err, value) => {
      if (over) {
        if (!err && value !== undefined) discard(value)
        return
      }
      finish(() => (err ? reject(err) : resolve(value as T)))
    })
  })
}

/** The most a background command may print before it is cut off. */
const EXEC_OUTPUT_LIMIT = 1024 * 1024

/** How long a channel request may go unanswered once signed in. */
const CHANNEL_TIMEOUT_MS = 30_000

/**
 * How far a session log may fall behind the disk before logging stops.
 *
 * A write to a slow or network disk queues in memory, and that queue had no
 * bound: `cat` of a large file into a logged session grew it for as long as
 * the output lasted, whatever the terminal's own flow control was doing.
 */
const LOG_BACKLOG_LIMIT = 8 * 1024 * 1024

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
  credential?: Credential,
  signal?: AbortSignal,
  /** Told of each client the moment it exists, so a cancel can close it at once. */
  track: (client: Client) => void = () => undefined
): Promise<{ target: Client; chain: Client[] }> {
  // Each hop carries its own inherited settings, resolved once up front.
  const hops: Array<{ profile: SessionProfile; auth: ResolvedAuth }> = []
  let cursor: SessionProfile | undefined = profile
  const seen = new Set<string>()
  while (cursor) {
    /*
     * The whole route is settled before a single socket opens. A jump host
     * that had been deleted used to end the walk quietly, and the connect went
     * ahead without it — straight to the destination, bypassing the bastion it
     * was meant to go through. A loop of jump hosts ended it just as quietly.
     * Either is now refused with the route that could not be followed.
     */
    if (seen.has(cursor.id)) {
      throw new Error(
        `The jump hosts of ${profile.name} lead back to ${cursor.name}, so there is no route to follow.`
      )
    }
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
    if (!auth.jumpHostId) break
    const jump = findProfile(auth.jumpHostId)
    if (!jump) {
      throw new Error(
        `${cursor.name} is set to connect through a jump host that no longer exists. Choose another one, or none, before connecting.`
      )
    }
    cursor = jump
  }

  const chain: Client[] = []
  let sock: Readable | undefined

  /*
   * Any way out of this but success closes every client opened on the way.
   *
   * It used to close none of them. Cancelling the password prompt for the
   * destination threw from `buildAuthConfig` with the jump host already signed
   * in, and nothing held a reference to it any more: an authenticated session to
   * the bastion, open until the bastion's own idle timeout or the application
   * quit. A wrong password, a refused forward or an unreachable destination did
   * the same.
   */
  try {
    for (let i = 0; i < hops.length; i++) {
      if (signal?.aborted) throw new ConnectCancelledError()
      const { profile: hop, auth } = hops[i]
      const client = new Client()
      chain.push(client)
      track(client)
      const authConfig = await buildAuthConfig(win, hop, auth, signal)
      if (signal?.aborted) throw new ConnectCancelledError()
      wireKeyboardInteractive(win, client, `${auth.username}@${hop.host}`, signal)
      const methods = methodWatcher(`sign-in ${auth.username}@${hop.host}:`)
      await signIn(
        client,
        {
          ...COMMON_CONNECT,
          debug: methods.debug,
          host: hop.host,
          port: auth.port,
          username: auth.username,
          hostVerifier: makeHostVerifier(win, hop.host, auth.port),
          ...authConfig,
          ...(sock ? { sock } : {})
        },
        signal,
        // Which machine, as whom, with what, and what it would have taken instead
        // — none of which ssh2's own message carries, and all of which decide
        // what to do about it.
        (err) => hopFailure(err, hop, auth, methods.seen()),
        methods.stop
      )

      const isLast = i === hops.length - 1
      if (!isLast) {
        const nextHop = hops[i + 1]
        sock = await answerOrGiveUp<Readable>(
          `${hop.name}, asked for a way through to ${nextHop.profile.name},`,
          (answer) =>
            client.forwardOut(
              '127.0.0.1',
              0,
              nextHop.profile.host,
              nextHop.auth.port,
              (err, stream) => answer(err, stream as unknown as Readable)
            ),
          signal,
          CHANNEL_TIMEOUT_MS,
          (late) => (late as unknown as { destroy: () => void }).destroy()
        )
      }
    }
    if (signal?.aborted) throw new ConnectCancelledError()
  } catch (err) {
    endClients(chain)
    throw err
  }

  return { target: chain[chain.length - 1], chain }
}

/** The first block of an id: enough to tell sessions apart in the journal. */
function short(connectionId: string): string {
  return connectionId.slice(0, 8)
}

/**
 * Output, as the journal sees it: how much, not what, and at most a line a
 * second per session — a build log would otherwise be the whole journal.
 */
const received = new Map<string, { bytes: number; chunks: number; timer?: NodeJS.Timeout }>()

function noteReceived(connectionId: string, bytes: number): void {
  let tally = received.get(connectionId)
  if (!tally) {
    tally = { bytes: 0, chunks: 0 }
    received.set(connectionId, tally)
  }
  tally.bytes += bytes
  tally.chunks++
  if (!tally.timer) {
    const t = tally
    t.timer = setTimeout(() => reportReceived(connectionId, t), 1000)
    t.timer.unref?.()
  }
}

function reportReceived(
  connectionId: string,
  tally: { bytes: number; chunks: number; timer?: NodeJS.Timeout }
): void {
  if (tally.timer) clearTimeout(tally.timer)
  tally.timer = undefined
  if (tally.chunks === 0) return
  diag('ssh', `${short(connectionId)} received ${tally.bytes} bytes in ${tally.chunks} chunks`)
  tally.bytes = 0
  tally.chunks = 0
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
   * Tells a session's pane about a failure beside the shell — a tunnel that
   * would not come up, say.
   *
   * Through the same queue as everything else the session says. Those tunnels
   * are started before `connect` has handed the id back, so a message sent
   * straight to the window went to a channel nobody could be listening on yet.
   */
  reportError(win: BrowserWindow, connectionId: string, message: string): void {
    this.send(win, connectionId, IPC.sshError, message)
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
    diag('ssh', `${short(connectionId)} window listening, ${conn.pending.length} held back`)
    if (conn.readyTimer) clearTimeout(conn.readyTimer)
    conn.readyTimer = undefined
    conn.ready = true
    const held = conn.pending
    conn.pending = []
    this.closing.delete(connectionId)
    if (win.isDestroyed()) return
    for (const { channel, payload } of held) {
      win.webContents.send(`${channel}:${connectionId}`, payload)
    }
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
      diag('ssh', `${short(conn.id)} paused, ${conn.inFlight} bytes unacknowledged`)
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
      diag('ssh', `${short(connectionId)} resumed`)
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
    credential?: Credential,
    /** Names this attempt, so the pane that started it can give up on it. */
    attemptId?: string
  ): Promise<string> {
    requireUnlocked()
    return this.attempt(attemptId, win, async (connectionId, signal, track) => {
      const { target, chain } = await connectChain(win, profile, credential, signal, track)
      await this.openShell(win, connectionId, target, chain, cols, rows, signal, profile)
    })
  }

  /** The same for a connection typed in by hand rather than saved. */
  async connectQuick(
    win: BrowserWindow,
    params: QuickConnectParams,
    cols: number,
    rows: number,
    attemptId?: string
  ): Promise<string> {
    requireUnlocked()
    return this.attempt(attemptId, win, async (connectionId, signal, track) => {
      const client = new Client()
      track(client)
      const auth: Pick<ConnectConfig, 'password' | 'privateKey' | 'passphrase' | 'agent'> =
        params.authMethod === 'password'
          ? { password: params.password }
          : params.authMethod === 'privateKey'
            ? params.privateKeyPath
              ? await readPrivateKey(params.privateKeyPath, params.passphrase)
              : { passphrase: params.passphrase }
            : { agent: agentSockForPlatform() }

      wireKeyboardInteractive(win, client, `${params.username}@${params.host}`, signal)
      const methods = methodWatcher(`sign-in ${params.username}@${params.host}:`)
      await signIn(
        client,
        {
          ...COMMON_CONNECT,
          debug: methods.debug,
          host: params.host,
          port: params.port,
          username: params.username,
          hostVerifier: makeHostVerifier(win, params.host, params.port),
          ...auth
        },
        signal,
        (err) => err,
        methods.stop
      )

      await this.openShell(win, connectionId, client, [client], cols, rows, signal)
    })
  }

  /** Connects still in progress, by the id the renderer gave each one. */
  private attempts = new Map<string, AbortController>()

  /**
   * Gives up on a connect that has not finished: every prompt it raised comes
   * down, every client it opened is closed, and it rejects rather than handing
   * back a session nobody is waiting for.
   */
  cancelConnect(attemptId: string): void {
    this.attempts.get(attemptId)?.abort()
  }

  /**
   * Every session and every connect still in progress, let go of at once — for
   * when the page that opened them has gone and nothing will ever close them
   * one by one.
   */
  releaseAll(): void {
    for (const controller of this.attempts.values()) controller.abort()
    for (const connectionId of [...this.connections.keys()]) this.teardown(connectionId)
    for (const conn of this.closing.values()) if (conn.readyTimer) clearTimeout(conn.readyTimer)
    this.closing.clear()
  }

  /**
   * The part every way of connecting shares: an id for the session, a signal
   * for giving up, and the rule that a connect which does not succeed leaves
   * nothing open behind it — whether it failed, was refused, or was cancelled
   * after the shell had already opened.
   */
  private async attempt(
    attemptId: string | undefined,
    win: BrowserWindow,
    run: (
      connectionId: string,
      signal: AbortSignal,
      track: (client: Client) => void
    ) => Promise<void>
  ): Promise<string> {
    const connectionId = randomUUID()
    const controller = new AbortController()
    if (attemptId) this.attempts.set(attemptId, controller)
    const clients: Client[] = []
    try {
      await run(connectionId, controller.signal, (client) => {
        clients.push(client)
      })
      if (controller.signal.aborted) throw new ConnectCancelledError()
      return connectionId
    } catch (err) {
      if (this.connections.has(connectionId)) this.teardown(connectionId)
      else endClients(clients)
      this.send(win, connectionId, IPC.sshError, (err as Error).message)
      throw err
    } finally {
      if (attemptId && this.attempts.get(attemptId) === controller) this.attempts.delete(attemptId)
    }
  }

  private openShell(
    win: BrowserWindow,
    connectionId: string,
    target: Client,
    chain: Client[],
    cols: number,
    rows: number,
    signal?: AbortSignal,
    profile?: SessionProfile
  ): Promise<void> {
    return answerOrGiveUp<ClientChannel>(
      'The host, asked for a shell,',
      (answer) => target.shell({ term: 'xterm-256color', cols, rows }, answer),
      signal,
      CHANNEL_TIMEOUT_MS,
      (late) => late.close()
    ).then((stream) => {
      const auth = profile ? effectiveAuth(profile) : undefined

      // The saved setting is only the starting point; the SFTP panel can turn
      // it on and off afterwards. Scanning is skipped entirely while it is off.
      const connection: LiveConnection = {
        fileAccess: auth?.fileAccess,
        id: connectionId,
        clients: chain,
        stream,
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
      if (profile?.logToFile) this.startLog(win, connection, profile)

      let pending = ''
      let lastCwd: string | undefined
      /*
       * One decoder for the life of the channel, not `toString` per chunk. The
       * setup line prints $PWD as raw UTF-8, and a read that ended inside a
       * character — any Cyrillic or accented folder name, sooner or later —
       * gave the panel a path with U+FFFD in it and a folder that does not
       * exist.
       */
      const utf8 = new StringDecoder('utf8')

      diag(
        'ssh',
        `${short(connectionId)} shell open, ${chain.length} hop(s), follow cwd ${connection.followCwd}`
      )
      stream.on('data', (raw: Buffer) => {
        noteReceived(connectionId, raw.length)
        // Still mid-login, or mid-anything: the setup line can wait.
        connection.setupWait?.restart()
        // The setup line is ours, not the user's, so its echo is taken back
        // out before anyone sees it. Scanning still runs on the full stream:
        // the sequence we are looking for rides in that same echo.
        const suppressor = connection.echoSuppressor
        const data = suppressor && !suppressor.done ? suppressor.push(raw) : raw

        if (data.length > 0) {
          this.queueOutput(win, connection, data)
          this.writeLog(win, connection, data)
        }
        if (!connection.followCwd) return
        const scan = scanOsc7(pending + utf8.write(raw))
        pending = scan.rest
        if (scan.path && scan.path !== lastCwd) {
          lastCwd = scan.path
          this.send(win, connectionId, IPC.sshCwd, scan.path)
        }
      })
      stream.stderr.on('data', (data: Buffer) => {
        this.queueOutput(win, connection, data)
      })
      /*
       * The steps a shell takes on the way out, each written down: the exit
       * status, the end of its output, and the channel closing. A session that
       * stops answering without reaching the last of them says here which one
       * it never got to.
       */
      stream.on('exit', (code: number | null, signal?: string) => {
        diag('ssh', `${short(connectionId)} remote exit code=${code} signal=${signal ?? '-'}`)
      })
      stream.on('end', () => diag('ssh', `${short(connectionId)} remote end of output`))
      stream.on('error', (e: Error) =>
        diag('ssh', `${short(connectionId)} channel error: ${e.message}`)
      )
      target.on('close', () => diag('ssh', `${short(connectionId)} client connection closed`))
      stream.on('close', () => {
        const tally = received.get(connectionId)
        if (tally) reportReceived(connectionId, tally)
        diag('ssh', `${short(connectionId)} channel closed, telling the window`)
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
    })
  }

  /**
   * Opens a session's log file, or says why it could not and carries on without.
   *
   * Every way a log can fail — a folder that cannot be made, a file that cannot
   * be opened, a disk that fills — used to surface as an error event nobody
   * listened for, which in the main process is an uncaught exception. A log is
   * worth less than the session it records, so a failing one stops and says so.
   */
  private startLog(win: BrowserWindow, conn: LiveConnection, profile: SessionProfile): void {
    try {
      const dir = join(app.getPath('userData'), 'logs')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const filename = `${profile.name.replace(/[^a-z0-9-_]+/gi, '_')}_${Date.now()}.log`
      const log = createWriteStream(join(dir, filename), { flags: 'a' })
      log.on('error', (err) => this.stopLog(win, conn, err.message))
      conn.logStream = log
    } catch (err) {
      this.stopLog(win, conn, (err as Error).message)
    }
  }

  private writeLog(win: BrowserWindow, conn: LiveConnection, data: Buffer): void {
    const log = conn.logStream
    if (!log) return
    if (log.writableLength > LOG_BACKLOG_LIMIT) {
      this.stopLog(win, conn, 'the disk is not keeping up with the output')
      return
    }
    log.write(data)
  }

  private stopLog(win: BrowserWindow, conn: LiveConnection, why: string): void {
    const log = conn.logStream
    conn.logStream = undefined
    if (log) {
      log.removeAllListeners('error')
      log.on('error', () => undefined)
      log.destroy()
    }
    this.send(win, conn.id, IPC.sshError, `Logging to a file stopped: ${why}`)
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
    const conn = this.connections.get(connectionId)
    // What arrived, as counts and control characters — see shared/diagnostics.ts.
    diag(
      'ssh',
      `${short(connectionId)} write ${describeInput(data)}${conn ? (conn.paused ? ' (paused)' : '') : ' to no live session'}`
    )
    conn?.stream.write(data)
  }

  resize(connectionId: string, cols: number, rows: number): void {
    this.connections.get(connectionId)?.stream.setWindow(rows, cols, 0, 0)
  }

  disconnect(connectionId: string): void {
    diag('ssh', `${short(connectionId)} disconnect asked for by the window`)
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
      let out = ''
      let settled = false
      let channel: ClientChannel | undefined
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const close = (stream: ClientChannel | undefined): void => {
        try {
          stream?.close()
        } catch {
          /* already gone */
        }
      }
      /*
       * Started before the channel is asked for, not once it opens. A host that
       * never answers the request for a channel left the poll pending for ever,
       * because the timer that was meant to catch a silent host only began
       * inside the answer it never gave.
       */
      const timer = setTimeout(() => {
        finish(() => {
          close(channel)
          reject(new Error('Timed out'))
        })
      }, timeoutMs)

      target.exec(command, (err, stream) => {
        if (settled) {
          close(stream)
          return
        }
        if (err) {
          finish(() => reject(err))
          return
        }
        channel = stream
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8')
          // A probe that prints without end is not a probe.
          if (out.length > EXEC_OUTPUT_LIMIT) {
            finish(() => {
              close(stream)
              reject(new Error('The command printed more than a probe should'))
            })
          }
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
    diag('ssh', `${short(connectionId)} teardown`)
    const tally = received.get(connectionId)
    if (tally?.timer) clearTimeout(tally.timer)
    received.delete(connectionId)
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
