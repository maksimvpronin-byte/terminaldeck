import { execFile } from 'child_process'
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

function native(action: 'read' | 'write', paths?: string[], version?: string): Promise<string> {
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
