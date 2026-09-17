import { app, ipcMain } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { IPC } from '../shared/ipc-channels'

/**
 * A running record of how sessions end and what the keyboard did on the way.
 *
 * Kept for a fault that cannot be reproduced on demand: a terminal that stops
 * answering after Ctrl+D, now and then, and only when it is typed through a
 * remote desktop. By the time anybody looks, the state that would explain it
 * is gone, so the events are written down as they happen — what was sent to a
 * session, what the session said back about ending, and which modifiers each
 * side believed were down.
 *
 * What goes in is described in `shared/diagnostics.ts`: counts and control
 * characters, never text. It lives beside the session logs, so the settings
 * button that opens that folder opens this too.
 */

/** Past this the file is moved aside once, so the journal is never more than twice it. */
const MAX_BYTES = 2 * 1024 * 1024
/** Lines are written in batches; a burst of keys is one write, not one each. */
const FLUSH_MS = 250
/** A line from the window longer than this is not a journal line. */
const MAX_LINE = 1000

let queue: string[] = []
let timer: NodeJS.Timeout | undefined

function dir(): string {
  return join(app.getPath('userData'), 'logs')
}

function flush(): void {
  timer = undefined
  if (queue.length === 0) return
  const text = queue.join('')
  queue = []
  try {
    const folder = dir()
    if (!existsSync(folder)) mkdirSync(folder, { recursive: true })
    const file = join(folder, 'diagnostics.log')
    if (existsSync(file) && statSync(file).size > MAX_BYTES) {
      const old = join(folder, 'diagnostics.1.log')
      rmSync(old, { force: true })
      renameSync(file, old)
    }
    appendFileSync(file, text)
  } catch {
    /* a journal that cannot be written must not take anything else down */
  }
}

/** One line in the journal: when, which side, and what happened. */
export function diag(source: string, message: string): void {
  queue.push(`${new Date().toISOString()} [${source}] ${message}\n`)
  if (!timer) {
    timer = setTimeout(flush, FLUSH_MS)
    timer.unref?.()
  }
}

export function registerDiagnostics(): void {
  ipcMain.on(IPC.diagLog, (_e, source: unknown, message: unknown) => {
    if (typeof source !== 'string' || typeof message !== 'string') return
    diag(`ui:${source.slice(0, 40)}`, message.slice(0, MAX_LINE))
  })
  // Whatever is still queued when the application goes is the end of the story.
  app.on('will-quit', flush)
  diag('app', `started ${app.getVersion()} on ${process.platform}`)
}
