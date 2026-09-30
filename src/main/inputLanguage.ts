import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { diag } from './diagnostics'
import { macKeyboard } from './macKeyboard'

/**
 * The Mac's input language, for a desktop to keep its own layout in step.
 *
 * Letters reach a desktop as the characters this Mac typed (see `textKey`), so
 * the layout over there never decided what was typed — but it is still what
 * the language indicator on its taskbar shows, and it still decides what a
 * program that reads keys rather than text receives. RDP has no message for
 * "the client changed its layout". It has two ways in, and both are used:
 *
 * - at connect, the layout the session starts in (`keyboardLayoutFor`), taken
 *   from whatever this Mac has selected at that moment;
 * - afterwards, the far side's own Alt+Shift, pressed by the window whenever
 *   this Mac's language changes under a focused desktop. See `alignLanguage`
 *   in RemoteScreen for what that can and cannot promise.
 */

/**
 * The Windows keyboard layout for a language, as the RDP connect sequence
 * carries it — the same identifiers FreeRDP's `/kbd` takes. Only languages
 * whose ordinary Mac layout has one plain Windows counterpart are here; any
 * other leaves the field unset and the server picks, as it always has.
 */
const LAYOUTS: Record<string, number> = {
  en: 0x0409,
  ru: 0x0419,
  uk: 0x0422,
  be: 0x0423,
  kk: 0x043f,
  de: 0x0407,
  fr: 0x040c,
  es: 0x040a,
  it: 0x0410,
  nl: 0x0413,
  sv: 0x041d,
  fi: 0x040b,
  cs: 0x0405,
  tr: 0x041f,
  el: 0x0408,
  he: 0x040d,
  ka: 0x0437
}

export function keyboardLayoutFor(language: string | null | undefined): number | undefined {
  return language ? LAYOUTS[language.toLowerCase()] : undefined
}

/** The Mac's language now, or undefined off a Mac or without the module. */
export function currentInputLanguage(): string | undefined {
  return macKeyboard()?.inputLanguage() ?? undefined
}

/** Once: the window may ask what the language is. */
export function registerInputLanguage(): void {
  ipcMain.handle(IPC.uiInputLanguage, () => currentInputLanguage() ?? null)
}

/** For this window: every change of language, as it happens. */
export function followInputLanguage(win: BrowserWindow): void {
  const native = macKeyboard()
  if (!native) return
  native.onInputLanguage((language) => {
    diag('keys', `input language is now ${language}`)
    if (!win.isDestroyed()) win.webContents.send(IPC.uiInputLanguageChanged, language)
  })
}
