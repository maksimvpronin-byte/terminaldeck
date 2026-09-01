import { app } from 'electron'
import { join } from 'path'
import { createHash } from 'crypto'
import { readJson, writeJson } from '../store/jsonFile'

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
  private data: KnownHostsFile

  constructor() {
    this.data = this.load()
  }

  private load(): KnownHostsFile {
    return readJson<KnownHostsFile>(storePath(), () => ({}))
  }

  private persist(): void {
    writeJson(storePath(), this.data)
  }

  get(host: string, port: number): string | undefined {
    return this.data[hostKeyOf(host, port)]
  }

  set(host: string, port: number, fp: string): void {
    this.data[hostKeyOf(host, port)] = fp
    this.persist()
  }

  remove(host: string, port: number): void {
    this.removeByKey(hostKeyOf(host, port))
  }

  /** Removes by the stored key, as shown in the trusted-hosts list. */
  removeByKey(key: string): void {
    delete this.data[key]
    this.persist()
  }

  all(): KnownHostsFile {
    return this.data
  }
}

export const knownHosts = new KnownHosts()
