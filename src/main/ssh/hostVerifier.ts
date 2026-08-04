import { dialog, BrowserWindow } from 'electron'
import { knownHosts, fingerprint, hostKeyOf } from './KnownHosts'

export type HostVerifier = (key: Buffer, callback: (ok: boolean) => void) => void

/**
 * Verifies the server's host key against the local known_hosts store, prompting
 * the user on first contact and warning loudly when a stored key no longer matches.
 */
export function makeHostVerifier(win: BrowserWindow, host: string, port: number): HostVerifier {
  return (key, callback) => {
    const fp = fingerprint(key)
    const stored = knownHosts.get(host, port)

    if (stored === fp) {
      callback(true)
      return
    }

    if (stored === undefined) {
      dialog
        .showMessageBox(win, {
          type: 'warning',
          title: 'Unknown host',
          message: `The authenticity of host ${hostKeyOf(host, port)} can't be established.`,
          detail:
            `Key fingerprint:\n${fp}\n\n` +
            'This is the first time TerminalDeck is connecting to this host. Continue only if ' +
            'this fingerprint matches the one you expect from the server.',
          buttons: ['Cancel', 'Trust and connect'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 1) {
            knownHosts.set(host, port, fp)
            callback(true)
          } else {
            callback(false)
          }
        })
        .catch(() => callback(false))
      return
    }

    dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Host key changed',
        message: `WARNING: the host key for ${hostKeyOf(host, port)} has changed!`,
        detail:
          `Expected:\n${stored}\n\nReceived:\n${fp}\n\n` +
          'This can mean the server was rebuilt or its key was rotated — but it can also mean ' +
          'someone is impersonating the server and intercepting your traffic. Do not continue ' +
          'unless you know why the key changed.',
        buttons: ['Cancel', 'Replace key and connect'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 1) {
          knownHosts.set(host, port, fp)
          callback(true)
        } else {
          callback(false)
        }
      })
      .catch(() => callback(false))
  }
}
