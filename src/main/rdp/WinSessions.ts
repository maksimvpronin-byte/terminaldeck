import { execFile } from 'child_process'
import {
  errorCode,
  parseSessions,
  qualifyUser,
  shadowArgs,
  type WinSession
} from '../../shared/winSessions'

/**
 * Listing and shadowing the sessions on a Windows host.
 *
 * Both lean on tools that ship with Windows, because the protocol underneath
 * shadowing is not RDP on 3389: it goes through RPC and SMB, and no client this
 * app could embed speaks it. `mstsc` therefore opens a window of its own, which
 * is the compromise this feature is — worth it because the alternative is not
 * having it at all.
 */

/**
 * Reaching the far machine is the slow step and needs room: signing in over
 * remoting takes seconds, and an earlier version cut it off at eight and blamed
 * a firewall that was open.
 *
 * Neither of these blocks the pane — the query runs beside the credentials, and
 * a new session can be started while it is still going.
 */
const REMOTE_TIMEOUT_MS = 25000
const QUERY_TIMEOUT_MS = 15000

export interface SessionQuery {
  sessions: WinSession[]
  /** Why the list is empty, when it is empty for a reason worth showing. */
  problem?: string
}

interface Credentials {
  username: string
  password: string
}


interface Run {
  code: number | null
  output: string
  timedOut: boolean
}

/**
 * A line in the terminal running the app, on the same switch the RDP gateway
 * uses. Which of these three steps failed is not guessable from the pane.
 */
const tracing =
  process.env.NODE_ENV === 'development' || process.env.TERMINALDECK_RDP_TRACE === '1'

function trace(message: string): void {
  if (!tracing) return
  // eslint-disable-next-line no-console
  console.log(`[rdp sessions] ${message}`)
}

/**
 * Runs a Windows tool, answering rather than throwing whatever happens.
 *
 * `secret` names an argument to hide from the trace. `extraEnv` is how a
 * password reaches a command without ever being one of its arguments, since an
 * argument is readable in the process list for as long as the command runs.
 */
function run(
  file: string,
  args: string[],
  timeout: number,
  secret?: number,
  extraEnv?: Record<string, string>,
  encoding: 'latin1' | 'utf8' = 'latin1'
): Promise<Run> {
  const started = Date.now()
  const shown = args.map((a, i) => (i === secret ? '***' : a)).join(' ')
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      // latin1 by default: the console tools answer in the console codepage —
      // cp866 on a Russian Windows — and decoding that as UTF-8 destroys the
      // bytes. latin1 maps every byte to a character reversibly, so the message
      // is unreadable but the numeric codes inside it survive, and those are
      // what the answers are matched on.
      //
      // The remoting path asks PowerShell for UTF-8 and must be read as UTF-8,
      // or its message is mangled twice over and stops being matchable at all.
      {
        timeout,
        windowsHide: true,
        encoding,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env
      },
      (err, stdout, stderr) => {
        const result: Run = {
          code: typeof err?.code === 'number' ? err.code : err ? 1 : 0,
          output: `${stdout}${stderr}`,
          timedOut: Boolean(err && 'killed' in err && (err as { killed?: boolean }).killed)
        }
        trace(
          `${file} ${shown} → exit ${result.code}` +
            `${result.timedOut ? ' (timed out)' : ''} in ${Date.now() - started}ms` +
            `${result.output.trim() ? ` — ${result.output.trim().split(/\r?\n/)[0]}` : ''}`
        )
        resolve(result)
      }
    )
    // Nothing is written in: closing it stops `net` waiting on a console
    // prompt if it ever decides to ask for something.
    child.stdin?.end()
  })
}

/**
 * Enumerates sessions through the Terminal Services API.
 *
 * The same source serves both routes: run against a host name it opens that
 * server, run against nothing it asks the machine it is on. Either way the state
 * comes back as a number and the names as Unicode, which is the point — `qwinsta`
 * answers in the host's language and its console code page, and neither survives
 * the trip.
 *
 * Failures are worded with the number in them, because that is all
 * `errorCode` can rely on reading.
 */
const WTS_ENUMERATOR = `
using System;
using System.Runtime.InteropServices;

public static class TerminalDeckWts
{
  [StructLayout(LayoutKind.Sequential)]
  struct SessionInfo { public int SessionId; public IntPtr WinStationName; public int State; }

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr WTSOpenServerW(string server);

  [DllImport("wtsapi32.dll")]
  static extern void WTSCloseServer(IntPtr server);

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int WTSEnumerateSessionsW(IntPtr server, int reserved, int version, ref IntPtr sessions, ref int count);

  [DllImport("wtsapi32.dll")]
  static extern void WTSFreeMemory(IntPtr memory);

  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool WTSQuerySessionInformationW(IntPtr server, int sessionId, int infoClass, out IntPtr buffer, out int bytes);

  public static string[] List(string host)
  {
    bool remote = !string.IsNullOrEmpty(host);
    IntPtr server = remote ? WTSOpenServerW(host) : IntPtr.Zero;
    if (remote && server == IntPtr.Zero) throw new Exception("error " + Marshal.GetLastWin32Error());

    IntPtr sessions = IntPtr.Zero;
    int count = 0;
    try
    {
      if (WTSEnumerateSessionsW(server, 0, 1, ref sessions, ref count) == 0)
        throw new Exception("error " + Marshal.GetLastWin32Error());

      string[] rows = new string[count];
      int size = Marshal.SizeOf(typeof(SessionInfo));
      for (int i = 0; i < count; i++)
      {
        IntPtr at = new IntPtr(sessions.ToInt64() + (long)i * size);
        SessionInfo info = (SessionInfo)Marshal.PtrToStructure(at, typeof(SessionInfo));
        rows[i] = info.SessionId + "\\t" + Marshal.PtrToStringUni(info.WinStationName)
          + "\\t" + info.State + "\\t" + UserName(server, info.SessionId);
      }
      return rows;
    }
    finally
    {
      if (sessions != IntPtr.Zero) WTSFreeMemory(sessions);
      if (server != IntPtr.Zero) WTSCloseServer(server);
    }
  }

  static string UserName(IntPtr server, int sessionId)
  {
    IntPtr buffer;
    int bytes;
    /* WTSUserName */
    if (!WTSQuerySessionInformationW(server, sessionId, 5, out buffer, out bytes)) return "";
    try { return Marshal.PtrToStringUni(buffer); }
    finally { WTSFreeMemory(buffer); }
  }
}
`

/**
 * Asks a host who is logged on to it.
 *
 * Never rejects: an unreachable host, a refused query and a machine with nobody
 * on it are all ordinary answers here, and a pane that opened to a thrown error
 * because the *optional* half of the dialog failed would be a poor trade.
 *
 * Two routes, because opening a host as a Terminal Services server signs its own
 * RPC in as whoever runs this app — a stranger to any machine outside the
 * domain, and no share connection opened beforehand changes that. So a host with
 * a login saved is asked to enumerate itself; everything else is asked directly.
 */
export function listSessions(host: string, credentials?: Credentials): Promise<SessionQuery> {
  if (process.platform !== 'win32') {
    return Promise.resolve({
      sessions: [],
      problem: 'Shadowing needs the Windows client, which only Windows has'
    })
  }

  // One query per host at a time, shared by everyone who asks while it runs.
  // A pane can mount more than once — React does exactly that in development —
  // and four `net use` calls racing for the same share end up fighting each
  // other over the single connection Windows allows per server.
  const running = inFlight.get(host)
  if (running) return running

  const query = ask(host, credentials).finally(() => inFlight.delete(host))
  inFlight.set(host, query)
  return query
}

const inFlight = new Map<string, Promise<SessionQuery>>()

async function ask(host: string, credentials?: Credentials): Promise<SessionQuery> {
  // The host's own login first, when there is one. A remote enumeration cannot
  // make use of it — see runOnHost — so the query runs on the far machine.
  let remotingProblem: string | undefined
  if (credentials?.username && credentials.password) {
    const remote = await runOnHost(host, credentials)
    if (remote.sessions.length > 0) return remote
    remotingProblem = remote.problem
  }

  // Still worth asking directly: this is the ordinary route on a domain member,
  // and also the one that works when the app itself runs as someone the host
  // knows.
  const query = await queryDirect(host)
  // Only a command that succeeded has a table to read. An error message is
  // shaped enough like a row to be parsed as one — `Ошибка 5 получения имен
  // сеансов` has a bare integer in the middle of it, and turned a refusal into
  // a session nobody was in.
  const sessions = query.code === 0 ? parseSessions(query.output) : []
  if (sessions.length > 0) return { sessions }

  // The remoting failure is the more useful thing to report when there was one:
  // it is the route that was meant to work, and the direct one's complaint —
  // "save a login for this host" — is nonsense to someone who just did.
  return { sessions: [], problem: remotingProblem ?? explainQuery(query) }
}

/**
 * Asks the host directly, opening it as a Terminal Services server.
 *
 * Nothing native writes to this console any more, so UTF-8 can simply go on
 * first: the enumerator answers in .NET strings, and the ordering that the
 * `qwinsta` capture needed — codepage for the tool, UTF-8 for the answer — has
 * nothing left to protect.
 */
function queryDirect(host: string): Promise<Run> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'try {',
    '  Add-Type -TypeDefinition $env:TD_WTS',
    '  [TerminalDeckWts]::List($env:TD_HOST)',
    '} catch {',
    // The failure has to become this process's exit code: with -Command
    // PowerShell exits 0 even after a terminating error, and a refusal that
    // looks like success gets its message read as a session list.
    '  $_ | Out-String -Width 200',
    '  exit 1',
    '}'
  ].join('; ')

  return run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    QUERY_TIMEOUT_MS,
    undefined,
    // Through the environment rather than into the script text, so no host name
    // can end the argument and begin another one.
    { TD_HOST: host, TD_WTS: WTS_ENUMERATOR },
    'utf8'
  )
}

/**
 * Runs the query on the host itself, over PowerShell remoting.
 *
 * `WTSOpenServer` authenticates its own RPC with the credentials of the process
 * that calls it — not with any share connection opened beforehand. So carrying
 * the host's login through `net use` did nothing for it: the query still went
 * out as whoever is running this app, who is nobody on a machine outside the
 * domain, and came back denied. `runas /netonly` fixes exactly that by hand and
 * cannot be scripted — it refuses a password from anywhere but the keyboard, on
 * purpose.
 *
 * Running the query on the far side sidesteps all of it. There it is a local
 * call, needing no remote enumeration rights at all.
 *
 * Always answers, never throws. An empty result with a `problem` says why this
 * route did not work, which the caller keeps in case the direct one fails too.
 */
async function runOnHost(host: string, credentials: Credentials): Promise<SessionQuery> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    // Read from the environment, never from the command line: an argument is
    // visible in the process list for as long as the command runs.
    '$sec = ConvertTo-SecureString $env:TD_PW -AsPlainText -Force',
    '$cred = New-Object System.Management.Automation.PSCredential($env:TD_USER, $sec)',
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'try {',
    '  Invoke-Command -ComputerName $env:TD_HOST -Credential $cred' +
      // WinRM otherwise inherits the machine's configured HTTP proxy and
      // refuses the connection outright — "proxy is not supported when using
      // the HTTP transport" — even though the host is on the local network.
      ' -SessionOption (New-PSSessionOption -ProxyAccessType NoProxyServer)' +
      // Nothing is passed for the host: on the far side this is the machine it
      // is already running on, and asking it to open itself as a remote server
      // would need the very rights this route exists to avoid.
      ' -ScriptBlock { param($source) Add-Type -TypeDefinition $source;' +
      ' [TerminalDeckWts]::List($null) }' +
      ' -ArgumentList $env:TD_WTS',
    '} catch {',
    '  $_ | Out-String -Width 200',
    '  exit 1',
    '}'
  ].join('; ')

  const attempt = await run(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    REMOTE_TIMEOUT_MS,
    undefined,
    {
      TD_HOST: host,
      TD_USER: qualifyUser(credentials.username, host),
      TD_PW: credentials.password,
      TD_WTS: WTS_ENUMERATOR
    },
    'utf8'
  )

  // Same rule as the direct route: a failed command has no table, and its error
  // text parses into a fake row if given the chance.
  if (attempt.code === 0) {
    const sessions = parseSessions(attempt.output)
    if (sessions.length > 0) return { sessions }
    return { sessions: [], problem: undefined }
  }

  /*
   * These are matched on words Windows does not translate — `TrustedHosts`,
   * `WSMan`, `WinRM`, `quickconfig`. Everything around them arrives in the
   * host's own language and the console codepage, so the prose is unreadable
   * here; an earlier version matched an English sentence and recognised
   * nothing on a Russian machine.
   */
  const text = attempt.output
  const trust = `Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value '${host}' -Concatenate -Force`

  // `cannot process the request` is the signature of the trust problem, and the
  // sentence naming TrustedHosts is often further into a message that gets cut
  // short — so the phrase is worth matching in its own right.
  if (/TrustedHosts/i.test(text) || /cannot process|не может обработать/i.test(text)) {
    return {
      sessions: [],
      problem: `This machine has to be told to trust ${host} before Windows will sign in to it over remoting — hosts outside a domain need that. Run once *here*, as administrator, and check it took: ${trust}`
    }
  }
  if (/quickconfig|WSMan|WinRM/i.test(text)) {
    // Which of the two it is cannot always be told apart from the text, and
    // both are one-liners, so both are named rather than guessed between.
    return {
      sessions: [],
      problem: `${host} could not be reached over WinRM, which is how a host outside a domain is asked who is logged on. Two things it needs, and it is usually the second: run Enable-PSRemoting -Force on that machine, and run this one here, as administrator: ${trust}`
    }
  }

  return { sessions: [], problem: undefined }
}

/** Why the query itself came back with nothing. */
function explainQuery(attempt: Run): string | undefined {
  const code = errorCode(attempt.output)
  if (attempt.timedOut) {
    return 'The host did not answer in time. This query signs in as the Windows account running this app — save an administrator login on the host and it can be asked over PowerShell remoting instead.'
  }
  if (code === 5) {
    // This is the direct route, so the query went out as whoever runs this app
    // — not as the login saved for the host, which no amount of policy on the
    // far side can change. The way through is remoting, which is tried first
    // whenever a login is saved and is what failed if we are here at all.
    return 'Access denied. This query goes out as the Windows account running this app, which the host does not know. Saving that host an administrator login lets it be asked over PowerShell remoting instead, which needs WinRM enabled on it.'
  }
  if (code === 1722 || code === 1723) {
    // Reached over RPC on 135 and a dynamic port above it — a different door
    // from the 445 that got us this far, and commonly still shut.
    return 'The host did not answer the session query (RPC). Port 445 is open, but this call goes over RPC on port 135 as well — that has to be reachable too.'
  }
  if (code) return `The host answered the query with error ${code}.`

  // The exit code is the reliable signal, and the last line of defence: the
  // message it came with is unreadable here, and a number cannot always be
  // picked out of it. Anything non-zero failed, whatever it said.
  if (attempt.code !== 0) {
    return 'The host refused the session query. Save it an administrator login and it can be asked over PowerShell remoting instead, which does not need remote enumeration rights at all.'
  }

  // No rows at all is not the same as a host with nobody on it: a real answer
  // always lists at least the services session and the listener. Saying "nobody
  // is logged on" for silence would be inventing a fact.
  if (!attempt.output.trim()) {
    return 'The host answered the query with nothing at all. It signed in, but the session service did not reply.'
  }
  return undefined
}

/**
 * Opens the Windows client on an existing session.
 *
 * Detached on purpose: this window belongs to the user, not to this app, and it
 * must outlive the pane that started it.
 */
export function shadowSession(
  host: string,
  sessionId: number,
  options: { control: boolean; skipPrompt: boolean }
): void {
  if (process.platform !== 'win32') throw new Error('Shadowing is only possible from Windows')

  const child = execFile('mstsc', shadowArgs(host, sessionId, options), { windowsHide: false })
  child.unref()
}
