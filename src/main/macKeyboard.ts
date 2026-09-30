import { app } from 'electron'
import { join } from 'path'
import { diag } from './diagnostics'

/**
 * `td_hotkeys.node`, the Mac-only native module in `resources/hotkeys`.
 *
 * Loaded once and shared: `systemHotkeys` takes ⌘Tab with it, and
 * `inputLanguage` reads and follows the Mac's layout. Nothing anywhere else,
 * and nothing at all off a Mac or in a checkout that never built it — each
 * caller works without it, only less.
 */
export interface MacKeyboard {
  /** Whether the switch for ⌘Tab exists on this macOS. */
  available(): boolean
  /** macOS's ⌘Tab and ⌘⇧Tab on or off; true when the window server took it. */
  setEnabled(enabled: boolean): boolean
  enabled(): boolean | null
  /** The selected layout's language, "en" or "ru", or null. */
  inputLanguage(): string | null
  /** Called with the new language whenever the selected layout changes. */
  onInputLanguage(callback: (language: string) => void): void
}

let loaded: MacKeyboard | null | undefined

export function macKeyboard(): MacKeyboard | null {
  if (loaded !== undefined) return loaded
  loaded = null
  if (process.platform !== 'darwin') return loaded
  const file = app.isPackaged
    ? join(process.resourcesPath, 'hotkeys', 'td_hotkeys.node')
    : join(app.getAppPath(), 'resources', 'hotkeys', 'build', 'td_hotkeys.node')
  try {
    const module = { exports: {} as MacKeyboard }
    process.dlopen(module, file)
    loaded = module.exports
  } catch (err) {
    // A checkout that never ran `npm run build:hotkeys`, most likely.
    diag(
      'keys',
      `no keyboard module (${(err as Error).message}); ⌘Tab and the layout stay as they are`
    )
  }
  return loaded
}
