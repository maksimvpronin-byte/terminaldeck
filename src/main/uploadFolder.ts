import { app } from 'electron'
import { dirname, join } from 'path'
import { statSync } from 'fs'
import { readJson, writeJson } from './store/jsonFile'

/**
 * The local folder the last upload was picked from, so the next one opens there.
 *
 * Without it every upload began wherever the system dialog chose — usually the
 * Documents folder — and the same few folders deep were walked again each time.
 * One folder for every host: what is being sent is the same set of local files
 * whichever server it goes to.
 */

interface UploadFolder {
  dir: string
}

function file(): string {
  return join(app.getPath('userData'), 'upload-folder.json')
}

function isUploadFolder(value: unknown): value is UploadFolder {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).dir === 'string'
  )
}

/** Where to open, if it is still a folder: a removed one opens somewhere arbitrary. */
export function lastUploadFolder(): string | undefined {
  const saved = readJson<UploadFolder | null>(file(), () => null, isUploadFolder)
  if (!saved) return undefined
  try {
    return statSync(saved.dir).isDirectory() ? saved.dir : undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps the folder holding what was picked. For a picked folder that is its
 * parent, so the next dialog shows it among its neighbours rather than inside it.
 */
export function rememberUploadFolder(picked: string[]): void {
  if (picked.length === 0) return
  try {
    writeJson(file(), { dir: dirname(picked[0]) })
  } catch (err) {
    // Only a convenience: the next upload opens where the system chooses.
    console.error('[upload] could not remember the folder', err)
  }
}
