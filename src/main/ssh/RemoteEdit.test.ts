import { describe, it, expect, vi } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
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

vi.mock('electron', () => ({
  shell: { openPath: async (): Promise<string> => '' },
  type: {}
}))
/*
 * The editor is somebody else's program; nothing here should start one. The
 * stub answers `spawn` at once, which is what the real one waits for before it
 * lets go of the handle.
 */
vi.mock('child_process', () => ({
  spawn: () => {
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

const { remoteEdit } = await import('./RemoteEdit')

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

  it('removes a copy whose session is still live', async () => {
    const local = await remoteEdit.open(win, 'connection-2', '/etc/hosts', 'true')
    remoteEdit.cleanUp()

    expect(existsSync(local)).toBe(false)
  })
})
