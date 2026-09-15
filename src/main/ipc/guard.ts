import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { TransferDecisions, TransferPlan } from '../../shared/types'

/**
 * What the main process checks about a request before it acts on it.
 *
 * TypeScript describes what the renderer is meant to send and checks nothing
 * that arrives. Every handler trusted its arguments to be what their types
 * said, and trusted whoever sent them to be the application's own page. The
 * page is sandboxed and never navigates, so both have held so far — but the
 * handlers include "write this file", "run this transfer plan" and "open a
 * shell", and a promise that holds only while nothing else goes wrong is not
 * one to rest those on.
 */

type Sender = IpcMainEvent | IpcMainInvokeEvent

/**
 * Accepts requests only from the top frame of a page this application loaded.
 *
 * Installed once, before any handler is registered, by wrapping the three ways
 * a handler is added — so a channel added later is covered without anyone
 * having to remember. `removeListener` is wrapped with them, or a listener
 * added through the wrapper could never be taken off again.
 */
export function installSenderCheck(isOwnPage: (url: string) => boolean): void {
  const trusted = (event: Sender): boolean => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    return isOwnPage(frame.url)
  }

  const originalHandle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) =>
    originalHandle(channel, (event, ...args) => {
      if (!trusted(event)) {
        throw new Error(`Refused ${channel} from a page that is not TerminalDeck`)
      }
      return listener(event, ...args)
    })

  type Listener = Parameters<typeof ipcMain.on>[1]
  const wrapped = new WeakMap<Listener, Listener>()
  const wrap = (channel: string, listener: Listener): Listener => {
    const guarded: Listener = (event, ...args) => {
      if (!trusted(event)) {
        console.error(`[security] refused ${channel} from a page that is not TerminalDeck`)
        return
      }
      listener(event, ...args)
    }
    wrapped.set(listener, guarded)
    return guarded
  }

  const originalOn = ipcMain.on.bind(ipcMain)
  const originalOnce = ipcMain.once.bind(ipcMain)
  const originalRemove = ipcMain.removeListener.bind(ipcMain)
  ipcMain.on = (channel, listener) => originalOn(channel, wrap(channel, listener))
  ipcMain.once = (channel, listener) => originalOnce(channel, wrap(channel, listener))
  ipcMain.removeListener = (channel, listener) =>
    originalRemove(channel, wrapped.get(listener) ?? listener)
  ipcMain.off = ipcMain.removeListener
}

/** Refuses an argument that is not what the channel takes. */
export function refuse(what: string): never {
  throw new Error(`Invalid request: ${what}`)
}

export function isString(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string') refuse(`${what} must be a string`)
}

export function isOptionalString(
  value: unknown,
  what: string
): asserts value is string | undefined {
  if (value !== undefined) isString(value, what)
}

export function isCount(value: unknown, what: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    refuse(`${what} must be a non-negative number`)
  }
}

const DIRECTIONS = ['upload', 'download', 'relay']
const REASONS = ['file', 'directory', 'symlink', 'unreadable', 'not-a-folder']

/**
 * A transfer plan as the renderer hands it back.
 *
 * The plan was made here and shown there, and it comes back to be run — which
 * makes it the one request whose every path is a place the main process will
 * write. So it is checked for shape before anything reads it.
 */
export function checkTransferPlan(
  plan: unknown,
  decisions: unknown
): { plan: TransferPlan; decisions: TransferDecisions } {
  if (typeof plan !== 'object' || plan === null) refuse('the plan must be an object')
  const p = plan as Record<string, unknown>
  if (typeof p.direction !== 'string' || !DIRECTIONS.includes(p.direction)) {
    refuse('the plan has no direction')
  }
  const items = (value: unknown, what: string): void => {
    if (!Array.isArray(value)) refuse(`${what} must be a list`)
    for (const item of value as unknown[]) {
      if (typeof item !== 'object' || item === null) {
        refuse(`${what} holds something that is not an item`)
      }
      const i = item as Record<string, unknown>
      isString(i.sourcePath, `${what}: sourcePath`)
      isString(i.destPath, `${what}: destPath`)
      isCount(i.sourceSize, `${what}: sourceSize`)
      if (typeof i.sourceMtime !== 'number') refuse(`${what}: sourceMtime must be a number`)
      if (i.isDirectory !== undefined && typeof i.isDirectory !== 'boolean') {
        refuse(`${what}: isDirectory must be true or false`)
      }
      if (i.reason !== undefined && !REASONS.includes(i.reason as string)) {
        refuse(`${what}: unknown conflict reason`)
      }
      if (i.sourcePath.includes('\0') || i.destPath.includes('\0')) {
        refuse(`${what}: a path holds NUL`)
      }
    }
  }
  items(p.items, 'plan items')
  items(p.conflicts, 'plan conflicts')
  if (!Array.isArray(p.collisions)) refuse('plan collisions must be a list')
  isCount(p.totalBytes, 'plan totalBytes')

  const d = decisions ?? {}
  if (typeof d !== 'object' || Array.isArray(d)) refuse('decisions must be an object')
  for (const answer of Object.values(d as Record<string, unknown>)) {
    if (answer !== 'overwrite' && answer !== 'skip') refuse('a decision must be overwrite or skip')
  }
  return { plan: plan as TransferPlan, decisions: d as TransferDecisions }
}
