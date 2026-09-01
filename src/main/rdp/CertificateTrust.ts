import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { setCertificateVerifier, type CertificateQuestion } from './certificateVerifier'
import { readJson, writeJson } from '../store/jsonFile'

/**
 * Which TLS certificates a desktop session may be carried over.
 *
 * Separate from `known_hosts.json` deliberately. An SSH host key and a TLS
 * certificate are different things with different lifetimes — a certificate
 * expires and is reissued on a schedule nobody controls — and revoking trust in
 * one should not touch the other.
 *
 * Nothing is stored for a certificate the system already trusts, which is the
 * common case for a gateway: a company that bought a public certificate does
 * not need this app to remember anything about it, and an entry that only
 * duplicates the system's own answer would go stale the day it is reissued.
 */

/** host:port -> "SHA256:base64" over the certificate's DER bytes. */
type TrustedCertificates = Record<string, string>

function storePath(): string {
  return join(app.getPath('userData'), 'known_certificates.json')
}

export function certificateFingerprint(der: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(der).digest('base64').replace(/=+$/, '')
}

export function certificateKeyOf(host: string, port: number): string {
  return `[${host}]:${port}`
}

class CertificateStore {
  private data: TrustedCertificates = this.load()

  private load(): TrustedCertificates {
    return readJson<TrustedCertificates>(storePath(), () => ({}))
  }

  private persist(): void {
    writeJson(storePath(), this.data)
  }

  get(host: string, port: number): string | undefined {
    return this.data[certificateKeyOf(host, port)]
  }

  set(host: string, port: number, fingerprint: string): void {
    this.data[certificateKeyOf(host, port)] = fingerprint
    this.persist()
  }

  removeByKey(key: string): void {
    delete this.data[key]
    this.persist()
  }

  all(): TrustedCertificates {
    return this.data
  }
}

export const trustedCertificates = new CertificateStore()

/** Installs the real answer to "should this certificate be trusted?". */
export function installCertificateVerifier(): void {
  setCertificateVerifier(async (question) => {
    // Verified against the system's own authorities: nothing to ask, and
    // nothing worth remembering — the certificate will be reissued one day and
    // a pinned copy would then look like an attack.
    if (question.authorized) return true

    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) return false

    const fingerprint = certificateFingerprint(question.der)
    const stored = trustedCertificates.get(question.host, question.port)
    if (stored === fingerprint) return true

    const where = `${question.what} ${question.host}:${question.port}`
    const answer =
      stored === undefined
        ? await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'Unknown certificate',
            message: `The certificate offered by ${where} cannot be verified.`,
            detail:
              `${question.problem ?? 'It is not signed by an authority this machine trusts'}.\n\n` +
              `Fingerprint:\n${fingerprint}\n\n` +
              'A company that issues its own certificates looks exactly like this — and so does ' +
              'something sitting in the middle of the connection. Continue only if this ' +
              'fingerprint is the one you expect.',
            buttons: ['Cancel', 'Trust and connect'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
        : await dialog.showMessageBox(window, {
            type: 'error',
            title: 'Certificate changed',
            message: `WARNING: the certificate for ${where} has changed!`,
            detail:
              `Expected:\n${stored}\n\nReceived:\n${fingerprint}\n\n` +
              'A certificate is reissued from time to time and this is the ordinary result — ' +
              'but it is also what interception looks like. Do not continue unless you know ' +
              'why it changed.',
            buttons: ['Cancel', 'Replace and connect'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })

    if (answer.response !== 1) return false
    trustedCertificates.set(question.host, question.port, fingerprint)
    return true
  })
}

export type { CertificateQuestion }
