import { app } from 'electron'
import { join } from 'path'
import type { Snippet } from '../../shared/types'
import { readJson, writeJson } from './jsonFile'

interface SnippetFile {
  version: 1
  snippets: Snippet[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'snippets.json')
}

class SnippetStore {
  private data: SnippetFile

  constructor() {
    this.data = this.load()
  }

  private load(): SnippetFile {
    // Normalised after reading rather than trusted: a file written by an older
    // version, or edited by hand, may be missing the list entirely.
    const parsed = readJson<Partial<SnippetFile>>(storePath(), () => ({}))
    return { version: 1, snippets: parsed.snippets ?? [] }
  }

  private persist(): void {
    writeJson(storePath(), this.data)
  }

  list(): Snippet[] {
    return this.data.snippets
  }

  save(snippet: Snippet): Snippet {
    const idx = this.data.snippets.findIndex((s) => s.id === snippet.id)
    if (idx >= 0) this.data.snippets[idx] = snippet
    else this.data.snippets.push(snippet)
    this.persist()
    return snippet
  }

  remove(id: string): void {
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id)
    this.persist()
  }
}

export const snippetStore = new SnippetStore()
