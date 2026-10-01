import { app } from 'electron'
import { join } from 'path'
import type { MultiWindow } from '../../shared/types'
import { applyOrder } from '../../shared/ordering'
import { JsonDocument, hasLists, readJson } from './jsonFile'

interface MultiWindowFile {
  version: 1
  multiWindows: MultiWindow[]
}

function storePath(): string {
  return join(app.getPath('userData'), 'multi-windows.json')
}

/**
 * Tabs kept by name, panes and all, to be opened again in one go. References
 * to hosts and accounts only, like the collections beside them — nothing in
 * this file is a secret.
 */
class MultiWindowStore {
  private doc = new JsonDocument<MultiWindowFile>(storePath, (path) => ({
    version: 1,
    multiWindows:
      readJson<Partial<MultiWindowFile>>(
        path,
        () => ({}),
        (v) => hasLists(v, { multiWindows: 'id' })
      ).multiWindows ?? []
  }))

  list(): MultiWindow[] {
    return this.doc.data.multiWindows
  }

  save(window: MultiWindow): MultiWindow {
    return this.saveMany([window])[0]
  }

  /** Several at once, in one write. */
  saveMany(windows: MultiWindow[]): MultiWindow[] {
    this.doc.change((d) => {
      for (const window of windows) {
        const idx = d.multiWindows.findIndex((w) => w.id === window.id)
        if (idx >= 0) d.multiWindows[idx] = window
        else d.multiWindows.push(window)
      }
    })
    return windows
  }

  reorder(ids: string[]): void {
    this.doc.change((d) => {
      d.multiWindows = applyOrder(d.multiWindows, ids)
    })
  }

  remove(id: string): void {
    this.doc.change((d) => {
      d.multiWindows = d.multiWindows.filter((w) => w.id !== id)
    })
  }

  snapshot(): MultiWindowFile {
    return this.doc.snapshot()
  }

  restore(previous: MultiWindowFile): void {
    this.doc.restore(previous)
  }
}

export const multiWindowStore = new MultiWindowStore()
