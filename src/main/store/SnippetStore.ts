import { app } from 'electron'
import { join } from 'path'
import type { Snippet } from '../../shared/types'
import { JsonDocument, hasLists, readJson } from './jsonFile'

interface SnippetFile {
  version: 1
  snippets: Snippet[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'snippets.json')
}

class SnippetStore {
  // Normalised after reading rather than trusted: a file written by an older
  // version, or edited by hand, may be missing the list entirely.
  private doc = new JsonDocument<SnippetFile>(storePath, (path) => {
    const parsed = readJson<Partial<SnippetFile>>(
      path,
      () => ({}),
      (v) => hasLists(v, { snippets: 'id' })
    )
    return { version: 1, snippets: parsed.snippets ?? [] }
  })

  list(): Snippet[] {
    return this.doc.data.snippets
  }

  save(snippet: Snippet): Snippet {
    this.saveMany([snippet])
    return snippet
  }

  /** Several at once, in one write. */
  saveMany(snippets: Snippet[]): void {
    this.doc.change((d) => {
      for (const snippet of snippets) {
        const idx = d.snippets.findIndex((s) => s.id === snippet.id)
        if (idx >= 0) d.snippets[idx] = snippet
        else d.snippets.push(snippet)
      }
    })
  }

  remove(id: string): void {
    this.doc.change((d) => {
      d.snippets = d.snippets.filter((s) => s.id !== id)
    })
  }

  snapshot(): SnippetFile {
    return this.doc.snapshot()
  }

  restore(previous: SnippetFile): void {
    this.doc.restore(previous)
  }
}

export const snippetStore = new SnippetStore()
