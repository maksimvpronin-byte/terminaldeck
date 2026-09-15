import { app } from 'electron'
import { join } from 'path'
import type { Credential } from '../../shared/types'
import { JsonDocument, hasLists, readJson } from './jsonFile'

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
  // Normalised rather than trusted: a file from an older version, or one edited
  // by hand, may have no list in it at all.
  private doc = new JsonDocument<CredentialFile>(storePath, (path) => {
    const parsed = readJson<Partial<CredentialFile>>(
      path,
      () => ({}),
      (v) => hasLists(v, { credentials: 'id' })
    )
    return { version: 1, credentials: parsed.credentials ?? [] }
  })

  list(): Credential[] {
    return this.doc.data.credentials
  }

  find(id: string | undefined): Credential | undefined {
    if (!id) return undefined
    return this.doc.data.credentials.find((c) => c.id === id)
  }

  save(credential: Credential): Credential {
    this.saveMany([credential])
    return credential
  }

  /** Several at once, in one write. */
  saveMany(credentials: Credential[]): void {
    this.doc.change((d) => {
      for (const credential of credentials) {
        const idx = d.credentials.findIndex((c) => c.id === credential.id)
        if (idx >= 0) d.credentials[idx] = credential
        else d.credentials.push(credential)
      }
    })
  }

  remove(id: string): void {
    this.doc.change((d) => {
      d.credentials = d.credentials.filter((c) => c.id !== id)
    })
  }

  snapshot(): CredentialFile {
    return this.doc.snapshot()
  }

  restore(previous: CredentialFile): void {
    this.doc.restore(previous)
  }
}

export const credentialStore = new CredentialStore()
