import { app } from 'electron'
import { join } from 'path'
import type { Credential } from '../../shared/types'
import { readJson, writeJson } from './jsonFile'

interface CredentialFile {
  version: 1
  credentials: Credential[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

/**
 * Logins kept apart from the hosts that use them.
 *
 * A file of its own rather than a corner of the session store, for the reason
 * collections have one: these belong to no host and to no group, and a host
 * that happens to be reached with one holds no reference to it. Nothing here
 * cascades, nothing here is inherited — an account is chosen at the moment of
 * connecting and applies to that session alone.
 *
 * Like every other store in this folder it holds a vault reference and never a
 * password. The file is worth no more to anyone who reads it than the host list
 * beside it.
 */
class CredentialStore {
  private data: CredentialFile

  constructor() {
    this.data = this.load()
  }

  private load(): CredentialFile {
    // Normalised rather than trusted: a file from an older version, or one
    // edited by hand, may have no list in it at all.
    const parsed = readJson<Partial<CredentialFile>>(storePath(), () => ({}))
    return { version: 1, credentials: parsed.credentials ?? [] }
  }

  private persist(): void {
    writeJson(storePath(), this.data)
  }

  list(): Credential[] {
    return this.data.credentials
  }

  find(id: string | undefined): Credential | undefined {
    if (!id) return undefined
    return this.data.credentials.find((c) => c.id === id)
  }

  save(credential: Credential): Credential {
    const idx = this.data.credentials.findIndex((c) => c.id === credential.id)
    if (idx >= 0) this.data.credentials[idx] = credential
    else this.data.credentials.push(credential)
    this.persist()
    return credential
  }

  remove(id: string): void {
    this.data.credentials = this.data.credentials.filter((c) => c.id !== id)
    this.persist()
  }
}

export const credentialStore = new CredentialStore()
