import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { basename, dirname } from 'path'
import type { BrowserWindow } from 'electron'

/**
 * The copies an edit leaves in the temporary directory, and whether they are
 * ever removed.
 *
 * Every file opened for editing is downloaded in the clear — a remote
 * `sshd_config` is the ordinary case — so "removed at quit" is the whole of the
 * promise. It was not kept: the clean-up walked the list of live edit sessions,
 * and a session is dropped the moment its connection closes, which for most
 * files happens long before the application exits.
 */

const fileState = vi.hoisted(() => ({ statError: false }))
/** What reached the "server", and whether it is reachable at all. */
const uploads = vi.hoisted(() => {
  const sent: { remote: string; contents: string }[] = []
  const state = { fail: false }
  return {
    sent,
    state,
    run: async (_id: string, local: string, remote: string): Promise<void> => {
      if (state.fail) throw new Error('Not connected')
      const { readFileSync: read } = await import('fs')
      sent.push({ remote, contents: read(local, 'utf8') })
    }
  }
})
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (fileState.statError) throw new Error('EACCES: file became unreadable')
      return actual.statSync(...args)
    }
  }
})
const openPath = vi.fn(async (_path: string): Promise<string> => '')
const spawned: { program: string; args: string[] }[] = []

vi.mock('electron', () => ({
  shell: { openPath: (path: string) => openPath(path) },
  type: {}
}))
/*
 * The editor is somebody else's program; nothing here should start one. The
 * stub answers `spawn` at once, which is what the real one waits for before it
 * lets go of the handle.
 */
vi.mock('child_process', () => ({
  spawn: (program: string, args: string[]) => {
    spawned.push({ program, args })
    const handlers = new Map<string, () => void>()
    setTimeout(() => handlers.get('spawn')?.(), 0)
    return {
      once: (event: string, fn: () => void) => handlers.set(event, fn),
      unref: () => undefined
    }
  }
}))
vi.mock('./SFTPManager', () => ({
  sftpManager: {
    // "Downloading" is writing the file the manager expects to find.
    download: vi.fn(async (_id: string, _remote: string, local: string): Promise<void> => {
      writeFileSync(local, 'contents', 'utf8')
    }),
    upload: (connectionId: string, local: string, remote: string): Promise<void> =>
      uploads.run(connectionId, local, remote)
  }
}))

const { remoteEdit, openInEditor } = await import('./RemoteEdit')

/** The window is only ever sent events; the ones about saves are kept to look at. */
const told: unknown[] = []
const win = {
  isDestroyed: () => false,
  webContents: { send: (_channel: string, payload: unknown) => void told.push(payload) }
} as unknown as BrowserWindow

/** Saves the copy as an editor would, with a modification time that is plainly newer. */
function save(local: string, contents: string): void {
  writeFileSync(local, contents, 'utf8')
  const later = new Date(Date.now() + 5_000)
  utimesSync(local, later, later)
}

describe('remote editing', () => {
  it('removes a copy at quit even when its connection closed first', async () => {
    const local = await remoteEdit.open(win, 'connection-1', '/etc/sshd_config', 'true')
    expect(existsSync(local)).toBe(true)

    // The tab is closed, which ends the session and stops the watcher — but the
    // editor may still hold the file, so the copy deliberately stays.
    remoteEdit.stopAllFor('connection-1')
    expect(existsSync(local)).toBe(true)
    expect(remoteEdit.temporaryDirs()).toHaveLength(1)

    // And at quit it goes, which is what used to be missed: the directory was
    // reachable only through the session that had just been forgotten.
    remoteEdit.cleanUp()
    expect(existsSync(local)).toBe(false)
    expect(remoteEdit.temporaryDirs()).toEqual([])
  })

  it('keeps a hostile remote name inside its temporary directory', async () => {
    // One legal file name on a Unix server; two steps up a tree on Windows.
    const local = await remoteEdit.open(win, 'connection-3', '/tmp/..\\..\\evil.dll', 'true')
    const [dir] = remoteEdit.temporaryDirs()

    expect(dirname(local)).toBe(dir)
    expect(basename(local)).toMatch(/evil\.dll$/)
    remoteEdit.cleanUp()
  })

  /**
   * A save waits 300 ms for the editor to finish writing. Quitting in that
   * time cleared the wait and deleted the copy: the server kept the old file,
   * and the new one was gone.
   */
  it('sends a save made just before quitting, then removes the copy', async () => {
    uploads.sent.length = 0
    const local = await remoteEdit.open(win, 'connection-4', '/etc/motd', 'true')
    save(local, 'edited')
    expect(remoteEdit.hasUnsynced()).toBe(true)

    await remoteEdit.flush(1_000)

    expect(uploads.sent).toEqual([{ remote: '/etc/motd', contents: 'edited' }])
    expect(remoteEdit.hasUnsynced()).toBe(false)
    expect(remoteEdit.cleanUp()).toEqual([])
    expect(existsSync(local)).toBe(false)
  })

  it('keeps a copy whose save could not be sent, and says where it is', async () => {
    const local = await remoteEdit.open(win, 'connection-5', '/etc/motd', 'true')
    save(local, 'edited offline')
    uploads.state.fail = true

    await remoteEdit.flush(1_000)
    const kept = remoteEdit.cleanUp()

    expect(kept).toEqual([local])
    expect(readFileSync(local, 'utf8')).toBe('edited offline')
  })

  it('tells the window when a closing connection leaves a save unsent', async () => {
    told.length = 0
    const local = await remoteEdit.open(win, 'connection-6', '/etc/motd', 'true')
    save(local, 'edited')

    remoteEdit.stopAllFor('connection-6')

    expect(told).toContainEqual({
      remotePath: '/etc/motd',
      error: `Not uploaded. The edited copy is kept at ${local}`
    })
    expect(remoteEdit.cleanUp()).toEqual([local])
    expect(existsSync(local)).toBe(true)
  })

  /** The editor outlives the tab: a save made in it afterwards is the only copy. */
  it('keeps a copy saved in its editor after the connection had closed', async () => {
    const local = await remoteEdit.open(win, 'connection-7', '/etc/motd', 'true')
    remoteEdit.stopAllFor('connection-7')
    save(local, 'edited after the tab was closed')

    expect(remoteEdit.cleanUp()).toEqual([local])
    expect(readFileSync(local, 'utf8')).toBe('edited after the tab was closed')
  })

  it('removes a copy whose session is still live', async () => {
    const local = await remoteEdit.open(win, 'connection-2', '/etc/hosts', 'true')
    remoteEdit.cleanUp()

    expect(existsSync(local)).toBe(false)
  })
})

/**
 * With no editor configured, the copy used to go to whatever the system opens
 * it with — and on Windows that runs a `.cmd`, a `.js` or a `.py` rather than
 * opening it. "Edit locally" must end in an editor whatever the file is called.
 */
describe('the editor used when none is configured', () => {
  it('opens a script in Notepad on Windows, never through the system handler', async () => {
    openPath.mockClear()
    spawned.length = 0
    await openInEditor('C:\\edit\\deploy.cmd', '  ', 'win32')

    expect(openPath).not.toHaveBeenCalled()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].program).toMatch(/System32[\\/]notepad\.exe$/i)
    expect(spawned[0].args).toEqual(['C:\\edit\\deploy.cmd'])
  })

  it('asks macOS for its text editor, not for the app that would run the file', async () => {
    openPath.mockClear()
    spawned.length = 0
    await openInEditor('/tmp/run.command', undefined, 'darwin')

    expect(openPath).not.toHaveBeenCalled()
    expect(spawned).toEqual([{ program: '/usr/bin/open', args: ['-t', '/tmp/run.command'] }])
  })

  it('still runs the editor that was configured', async () => {
    spawned.length = 0
    await openInEditor('/tmp/a.txt', 'code -w {file}', 'win32')

    expect(spawned).toEqual([{ program: 'code', args: ['-w', '/tmp/a.txt'] }])
  })
})

describe('opening one file twice at once', () => {
  /**
   * Two clicks before the first download finished made two copies, and the
   * second session replaced the first: saves in the first editor went to a
   * session watching the other copy, and never reached the server.
   */
  it('makes one copy, and opens it for both', async () => {
    const [first, second] = await Promise.all([
      remoteEdit.open(win, 'connection-twice', '/etc/hosts', 'true'),
      remoteEdit.open(win, 'connection-twice', '/etc/hosts', 'true')
    ])
    expect(second).toBe(first)
    expect(remoteEdit.list('connection-twice')).toEqual(['/etc/hosts'])
    remoteEdit.cleanUp()
  })
})

describe('a watched copy whose folder goes away', () => {
  it('stops watching instead of raising an error nobody handles', async () => {
    await remoteEdit.open(win, 'connection-gone', '/etc/motd', 'true')
    const session = (
      remoteEdit as unknown as { sessions: Map<string, { watcher: import('fs').FSWatcher }> }
    ).sessions.get('connection-gone:/etc/motd')!
    // What Windows emits when the watched directory is deleted.
    expect(() => session.watcher.emit('error', new Error('EPERM'))).not.toThrow()
    expect(remoteEdit.list('connection-gone')).toEqual([])
    remoteEdit.cleanUp()
  })
})

describe('a path with a dollar sign in it', () => {
  it('reaches the editor as it is', async () => {
    spawned.length = 0
    await openInEditor("/tmp/cost$&$'.txt", 'myeditor --file={file}')
    expect(spawned.at(-1)?.args).toEqual(["--file=/tmp/cost$&$'.txt"])
  })
})

const { sftpManager } = await import('./SFTPManager')
afterEach(() => {
  fileState.statError = false
  uploads.state.fail = false
  remoteEdit.cleanUp()
})

describe('editor arguments', () => {
  it('handles quotes within arguments, empty arguments and Windows backslashes', async () => {
    await openInEditor('C:\\My Files\\a.txt', '"C:\\Program Files\\editor.exe" --file="{file}" ""')
    expect(spawned.at(-1)).toEqual({
      program: 'C:\\Program Files\\editor.exe',
      args: ['--file=C:\\My Files\\a.txt', '']
    })
  })
  it('refuses an unfinished quote before launching anything', async () => {
    const count = spawned.length
    await expect(openInEditor('/tmp/a', 'editor "{file}')).rejects.toThrow('Unclosed quote')
    expect(spawned).toHaveLength(count)
  })
  it('replaces every placeholder without interpreting dollar signs', async () => {
    await openInEditor('/tmp/$&', 'editor {file}:{file}')
    expect(spawned.at(-1)?.args).toEqual(['/tmp/$&:/tmp/$&'])
  })
})

describe('closing a connection during a download', () => {
  it('does not launch the editor or revive the watch after disconnect', async () => {
    let finish!: () => void
    vi.mocked(sftpManager.download).mockImplementationOnce(async (_id, _remote, local) => {
      await new Promise<void>((r) => {
        finish = r
      })
      writeFileSync(local, 'contents')
    })
    const count = spawned.length
    const opening = remoteEdit.open(win, 'closing', '/etc/hosts', 'editor')
    const rejected = expect(opening).rejects.toThrow('SSH connection closed')
    remoteEdit.stopAllFor('closing')
    finish()
    await rejected
    expect(remoteEdit.list('closing')).toEqual([])
    expect(spawned).toHaveLength(count)
  })
})

it('reports stat errors through the edit event instead of rejecting the timer task', async () => {
  await remoteEdit.open(win, 'stat-error', '/etc/hosts', 'editor')
  const send = vi.fn()
  const reportingWin = {
    isDestroyed: () => false,
    webContents: { send }
  } as unknown as BrowserWindow
  fileState.statError = true
  const internals = remoteEdit as unknown as {
    upload: (win: BrowserWindow, key: string) => Promise<void>
  }
  await expect(internals.upload(reportingWin, 'stat-error:/etc/hosts')).resolves.toBeUndefined()
  expect(send).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ error: expect.stringContaining('EACCES') })
  )
})
