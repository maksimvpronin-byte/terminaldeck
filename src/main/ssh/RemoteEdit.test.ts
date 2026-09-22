import { describe, it, expect, vi } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
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
    download: async (_id: string, _remote: string, local: string): Promise<void> => {
      writeFileSync(local, 'contents', 'utf8')
    },
    upload: async (): Promise<void> => undefined
  }
}))

const { remoteEdit, openInEditor } = await import('./RemoteEdit')

/** The window is only ever sent events; none of them matter here. */
const win = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
} as unknown as BrowserWindow

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
