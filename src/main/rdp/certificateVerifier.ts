/**
 * Where the desktop code asks whether a TLS certificate should be trusted.
 *
 * FreeRDP asks through this boundary; the main process installs the dialog
 * and certificate-store implementation at startup.
 */

export interface CertificateQuestion {
  host: string
  port: number
  /** The certificate in DER form, which is what gets fingerprinted. */
  der: Buffer
  /** Node's own verdict against the system authorities. */
  authorized: boolean
  /** Why it failed, when it did — `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and friends. */
  problem?: string
  /** What the certificate is for, in words, for the dialog. */
  what: 'the gateway' | 'the desktop host'
}

export type CertificateVerifier = (question: CertificateQuestion) => Promise<boolean>

/**
 * Refuses by default.
 *
 * A build that forgot to install the real one would otherwise accept every
 * certificate silently, which is the failure this whole mechanism exists to
 * prevent — better a connection that stops with a plain reason.
 */
let verifier: CertificateVerifier = async () => false

export function setCertificateVerifier(fn: CertificateVerifier): void {
  verifier = fn
}

export function askAboutCertificate(question: CertificateQuestion): Promise<boolean> {
  return verifier(question)
}
