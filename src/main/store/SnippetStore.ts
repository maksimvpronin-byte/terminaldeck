import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs'
import type { Snippet } from '../../shared/types'

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
    const p = storePath()
    if (!existsSync(p)) return { version: 1, snippets: [] }
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<SnippetFile>
      return { version: 1, snippets: parsed.snippets ?? [] }
    } catch {
      return { version: 1, snippets: [] }
    }
  }

  private persist(): void {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const target = storePath()
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, target)
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
