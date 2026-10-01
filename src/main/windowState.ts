import { app, screen, type BrowserWindow } from 'electron'
import { join } from 'path'
import { readJson, writeJson } from './store/jsonFile'
import { restorePlacement, type Box } from '../shared/windowPlacement'

/**
 * Where the window was and how large, so the next start opens it there.
 *
 * Its normal bounds, not the maximised or full-screen ones: those come back by
 * maximising again, and a window restored *to* the size of the screen could
 * not be made smaller by un-maximising it. Full screen is not brought back at
 * all — it belongs to a desktop pane, and none is connected at launch.
 */
interface WindowState extends Box {
  maximized: boolean
}

function file(): string {
  return join(app.getPath('userData'), 'window.json')
}

export function isWindowState(value: unknown): value is WindowState {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    ['x', 'y', 'width', 'height'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k])) &&
    typeof v.maximized === 'boolean'
  )
}

/** The bounds to open with, fitted to the displays attached now, if any were saved. */
export function savedWindowPlacement(min: { width: number; height: number }): {
  bounds?: Box
  maximized: boolean
} {
  const saved = readJson<WindowState | null>(file(), () => null, isWindowState)
  if (!saved) return { maximized: false }
  const primary = screen.getPrimaryDisplay()
  // The primary first, so a window from a display that has gone lands there.
  const ordered = [
    primary.workArea,
    ...screen
      .getAllDisplays()
      .filter((d) => d.id !== primary.id)
      .map((d) => d.workArea)
  ]
  return { bounds: restorePlacement(saved, ordered, min), maximized: saved.maximized }
}

/** Saves where the window is whenever it moves or changes size, and on closing. */
export function rememberWindowPlacement(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined
  const save = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return
    try {
      writeJson(file(), { ...win.getNormalBounds(), maximized: win.isMaximized() })
    } catch (err) {
      // Where a window opens is not worth an error to anyone; it opens where
      // it did before this was saved.
      console.error('[window] could not save its placement', err)
    }
  }
  // Moving and resizing arrive many times a second while the mouse drags.
  const soon = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', soon)
  win.on('move', soon)
  win.on('maximize', soon)
  win.on('unmaximize', soon)
  win.on('close', save)
}
