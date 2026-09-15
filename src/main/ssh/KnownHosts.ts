import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { JsonDocument, readJson } from '../store/jsonFile'

/** host:port -> OpenSSH-style "SHA256:base64" fingerprint of the server key. */
type KnownHostsFile = Record<string, string>

function storePath(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

export function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function hostKeyOf(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

class KnownHosts {
  /*
   * Changed through a copy that reached the disk, above all here: a key trusted
   * in memory and not on disk is trusted for this run and asked about again
   * after a restart, and the reverse — a key removed on screen that is still in
   * the file — comes back trusted.
   */
  private doc = new JsonDocument<KnownHostsFile>(storePath, (path) =>
    readJson<KnownHostsFile>(path, () => ({}))
  )

  get(host: string, port: number): string | undefined {
    return this.doc.data[hostKeyOf(host, port)]
  }

  set(host: string, port: number, fp: string): void {
    this.doc.change((d) => {
      d[hostKeyOf(host, port)] = fp
    })
  }

  remove(host: string, port: number): void {
    this.removeByKey(hostKeyOf(host, port))
  }

  /** Removes by the stored key, as shown in the trusted-hosts list. */
  removeByKey(key: string): void {
    this.doc.change((d) => {
      delete d[key]
    })
  }

  all(): KnownHostsFile {
    return this.doc.data
  }
}

export const knownHosts = new KnownHosts()
