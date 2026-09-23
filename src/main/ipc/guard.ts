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

/** An integer within bounds. */
export function isInt(
  value: unknown,
  min: number,
  max: number,
  what: string
): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    refuse(`${what} must be a whole number from ${min} to ${max}`)
  }
}

/**
 * A terminal's size. The far end is told this, and a pseudo-terminal of a
 * million columns is a request some servers take literally.
 */
export function isTerminalSize(cols: unknown, rows: unknown): void {
  isInt(cols, 1, 2000, 'cols')
  isInt(rows, 1, 1000, 'rows')
}

/** The most one keystroke message may carry: a large paste, not a file. */
export const MAX_TERMINAL_WRITE = 4 * 1024 * 1024

/** A connection typed in by hand, checked before anything dials it. */
export function checkQuickConnect(params: unknown): void {
  if (typeof params !== 'object' || params === null) refuse('connection details must be an object')
  const p = params as Record<string, unknown>
  isString(p.host, 'host')
  if (!p.host.trim() || p.host.startsWith('-')) refuse('host is not a host name')
  isInt(p.port, 1, 65535, 'port')
  isString(p.username, 'username')
  if (!['password', 'privateKey', 'agent'].includes(p.authMethod as string)) {
    refuse('authMethod is not one this application knows')
  }
  isOptionalString(p.password, 'password')
  isOptionalString(p.privateKeyPath, 'privateKeyPath')
  isOptionalString(p.passphrase, 'passphrase')
}

/** Where a desktop typed in by hand is, checked before the client dials it. */
export interface QuickDesktop {
  host: string
  port: number
  username: string
}

export function checkQuickDesktop(value: unknown): asserts value is QuickDesktop {
  if (typeof value !== 'object' || value === null) refuse('desktop details must be an object')
  const d = value as Record<string, unknown>
  isString(d.host, 'host')
  // The client is handed the host as a value, never as an argument — but a
  // name that starts with a dash is not a host name either way.
  if (!d.host.trim() || d.host.startsWith('-') || /[\s\0]/.test(d.host.trim())) {
    refuse('host is not a host name')
  }
  isInt(d.port, 1, 65535, 'port')
  isString(d.username, 'username')
}

/** A port forwarding rule, checked before a port is bound or a remote asked to listen. */
export function checkForwardRule(rule: unknown): void {
  if (typeof rule !== 'object' || rule === null) refuse('the rule must be an object')
  const r = rule as Record<string, unknown>
  isString(r.id, 'rule id')
  if (!['local', 'remote', 'dynamic'].includes(r.type as string)) refuse('rule type is unknown')
  isString(r.srcHost, 'srcHost')
  isInt(r.srcPort, 0, 65535, 'srcPort')
  isOptionalString(r.dstHost, 'dstHost')
  if (r.dstPort !== undefined) isInt(r.dstPort, 0, 65535, 'dstPort')
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
