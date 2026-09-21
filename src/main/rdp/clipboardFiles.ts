import { execFile, spawn, type ChildProcess } from 'child_process'
import { clipboard } from 'electron'
import { fileURLToPath, pathToFileURL } from 'url'

// Native file lists are different from text that happens to contain a path.
// Arguments/data are never interpolated into executable code.
const mac = `ObjC.import('AppKit'); ObjC.import('Foundation');
function run(args) {
  const pb = $.NSPasteboard.generalPasteboard;
  if (args[0] === 'write') {
    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    const input = JSON.parse(text);
    const paths = input.paths;
    if (input.version !== undefined && String(pb.changeCount) !== input.version) return 'changed';
    const urls = $.NSMutableArray.alloc.init;
    paths.forEach(p => urls.addObject($.NSURL.fileURLWithPath(p)));
    pb.clearContents;
    if (!pb.writeObjects(urls)) throw Error('Cannot write file clipboard');
    return String(pb.changeCount);
  }
  const values = pb.readObjectsForClassesOptions($([$.NSURL]), $({NSPasteboardURLReadingFileURLsOnlyKey: true}));
  const paths = [];
  if (values) for (let i = 0; i < values.count; i++) paths.push(values.objectAtIndex(i).path.js);
  return JSON.stringify({paths: paths, version: String(pb.changeCount)});
}`
const windows = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TdClipboard { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }' 
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
if ($env:TD_CLIP_ACTION -eq 'write') {
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($null -ne $inputData.version -and [string][TdClipboard]::GetClipboardSequenceNumber() -ne $inputData.version) { Write-Output 'changed'; exit }
  $items = $inputData.paths
  $list = [System.Collections.Specialized.StringCollection]::new()
  foreach ($item in $items) { [void]$list.Add([string]$item) }
  [System.Windows.Forms.Clipboard]::SetFileDropList($list)
  [string][TdClipboard]::GetClipboardSequenceNumber()
} else {
  $items = @([System.Windows.Forms.Clipboard]::GetFileDropList())
  ConvertTo-Json -InputObject @{ paths = $items; version = [string][TdClipboard]::GetClipboardSequenceNumber() } -Compress
}`

/**
 * The same two actions, answered by one PowerShell that stays running.
 *
 * Each read used to start PowerShell afresh, load Windows Forms and compile the
 * P/Invoke above — 270 to 290 ms before it read anything, once a second while a
 * desktop was open, and on every text copy too, since new text waits for the
 * file list to be read with it. Started once, the same work is paid once and a
 * read costs a few milliseconds.
 *
 * One request per line in, one answer per line out, in order. The answer is
 * what the one-shot script prints; a failure is `ERR` and the reason.
 */
const windowsServer = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class TdClipboard { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $request = $line | ConvertFrom-Json
    if ($request.action -eq 'write') {
      if ($null -ne $request.version -and [string][TdClipboard]::GetClipboardSequenceNumber() -ne $request.version) { $answer = 'changed' }
      else {
        $list = [System.Collections.Specialized.StringCollection]::new()
        foreach ($item in $request.paths) { [void]$list.Add([string]$item) }
        [System.Windows.Forms.Clipboard]::SetFileDropList($list)
        $answer = [string][TdClipboard]::GetClipboardSequenceNumber()
      }
    } else {
      $items = @([System.Windows.Forms.Clipboard]::GetFileDropList())
      $answer = ConvertTo-Json -InputObject @{ paths = $items; version = [string][TdClipboard]::GetClipboardSequenceNumber() } -Compress
    }
    [Console]::Out.WriteLine($answer)
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '[\\r\\n]+', ' '))
  }
  [Console]::Out.Flush()
}`

/** How long an answer may take before the helper is taken to be stuck. */
const HELPER_TIMEOUT_MS = 5000
/** How long the helper is kept after its last request, so it does not outlive the desktops. */
const HELPER_IDLE_MS = 60_000

interface Pending {
  resolve: (line: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * The running helper, started on the first request and let go once idle.
 *
 * Requests are answered in the order they were sent, so the oldest waiting one
 * takes each line. A helper that exits, or takes too long, is dropped with
 * every request it held failed — the caller then falls back to the one-shot
 * script, and the next request starts a fresh helper.
 */
class ClipboardHelper {
  private child: ChildProcess | undefined
  private waiting: Pending[] = []
  private buffered = ''
  private idle: NodeJS.Timeout | undefined

  constructor(
    private readonly command: string,
    private readonly args: string[]
  ) {}

  request(line: string): Promise<string> {
    const child = this.child ?? this.start()
    clearTimeout(this.idle)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => this.drop(new Error('The clipboard helper did not answer')),
        HELPER_TIMEOUT_MS
      )
      this.waiting.push({ resolve, reject, timer })
      child.stdin?.write(`${line}\n`)
    })
  }

  private start(): ChildProcess {
    const child = spawn(this.command, this.args, { windowsHide: true, stdio: 'pipe' })
    this.child = child
    this.buffered = ''
    // Each handler speaks only for its own process: one that was dropped and
    // exits later must not take its replacement down with it.
    const current = (): boolean => this.child === child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (current()) this.receive(chunk)
    })
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => {
      if (current()) this.drop(error)
    })
    child.on('exit', () => {
      if (current()) this.drop(new Error('The clipboard helper exited'))
    })
    // The helper is never the reason the application stays open.
    child.unref()
    return child
  }

  private receive(chunk: string): void {
    this.buffered += chunk
    for (;;) {
      const end = this.buffered.indexOf('\n')
      if (end < 0) return
      const line = this.buffered.slice(0, end).replace(/\r$/, '')
      this.buffered = this.buffered.slice(end + 1)
      const next = this.waiting.shift()
      if (!next) continue
      clearTimeout(next.timer)
      if (line.startsWith('ERR ')) next.reject(new Error(line.slice(4)))
      else next.resolve(line)
      if (this.waiting.length === 0) {
        clearTimeout(this.idle)
        this.idle = setTimeout(() => this.drop(), HELPER_IDLE_MS)
        this.idle.unref?.()
      }
    }
  }

  /** Lets the helper go, failing whatever it still owed. */
  private drop(error?: Error): void {
    const child = this.child
    this.child = undefined
    clearTimeout(this.idle)
    for (const pending of this.waiting.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(error ?? new Error('The clipboard helper was stopped'))
    }
    if (child && child.exitCode === null) {
      child.stdin?.end()
      child.kill()
    }
  }
}

const windowsHelper = new ClipboardHelper('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-STA',
  '-Command',
  windowsServer
])

async function native(action: 'read' | 'write', paths?: string[], version?: string): Promise<string> {
  if (process.platform === 'win32') {
    try {
      return await windowsHelper.request(JSON.stringify({ action, paths, version }))
    } catch {
      // The one-shot script below still works when the helper will not.
    }
  }
  return nativeOnce(action, paths, version)
}

function nativeOnce(action: 'read' | 'write', paths?: string[], version?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const isMac = process.platform === 'darwin'
    const child = execFile(
      isMac ? '/usr/bin/osascript' : 'powershell.exe',
      isMac
        ? ['-l', 'JavaScript', '-e', mac, action]
        : ['-NoProfile', '-NonInteractive', '-STA', '-Command', windows],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, TD_CLIP_ACTION: action }
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(paths ? JSON.stringify({ paths, version }) : '')
  })
}

/**
 * The file list as the RDP client's parser will read it back.
 *
 * `pathToFileURL` writes a share as `file://server/share/file`, putting the
 * server in the authority field — which is correct, and which FreeRDP refuses:
 * it accepts an empty authority and nothing else, so a file copied from a
 * network share failed with the host unable to say why. An empty authority
 * followed by the share as an absolute path — `file:////server/share/file` —
 * is the same location, survives that parser, and Windows turns the leading
 * pair of slashes back into a UNC path when it opens the file.
 *
 * Split out from the walk over the paths because only Windows produces an
 * authority to move, and the tests do not run there.
 */
export function withEmptyAuthority(href: string): string {
  return href.startsWith('file:///') ? href : `file://${href.slice('file:'.length)}`
}

export function pathsToUris(paths: string[]): string {
  return paths.map((p) => withEmptyAuthority(pathToFileURL(p).href)).join('\r\n')
}

export interface FileClipboardSnapshot {
  paths: string[]
  version: string
}
export async function readFileClipboard(): Promise<FileClipboardSnapshot> {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const result = JSON.parse((await native('read')).trim()) as FileClipboardSnapshot
    if (
      !Array.isArray(result.paths) ||
      result.paths.some((p) => typeof p !== 'string') ||
      typeof result.version !== 'string'
    )
      throw new Error('Invalid file clipboard')
    return result
  }
  const uris = clipboard.readBuffer('text/uri-list').toString('utf8')
  return {
    paths: uris
      .split(/\r?\n/)
      .filter((line) => line.startsWith('file:'))
      .map((line) => fileURLToPath(line)),
    version: JSON.stringify([uris, clipboard.readText()])
  }
}

/** Compare clipboard ownership inside the native writer before replacing it. */
export async function writeClipboardFiles(
  paths: string[],
  version: string
): Promise<string | undefined> {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const result = (await native('write', paths, version)).trim()
    return result === 'changed' ? undefined : result
  }
  if ((await readFileClipboard()).version !== version) return undefined
  clipboard.writeBuffer('text/uri-list', Buffer.from(pathsToUris(paths)))
  return (await readFileClipboard()).version
}
