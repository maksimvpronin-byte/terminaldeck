/**
 * This machine's input language.
 *
 * On a Mac the main process knows it — a native module hears every change the
 * moment macOS makes it — and that is passed through unchanged, for a desktop
 * that types the Mac's characters to keep its own layout in step.
 *
 * Anywhere else it is asked for once, when a desktop connects, so the session
 * starts in the layout this keyboard is in, as mstsc starts it. Afterwards the
 * keys go as keys and the language switch pressed here reaches the far side,
 * which changes language itself; nothing here needs to follow it. It is read
 * from the keyboard map Chromium keeps (`navigator.keyboard.getLayoutMap`).
 */

/** Whether the main process speaks for this machine, which it does on a Mac. */
let native: boolean | undefined

/** The language of a letter, by its alphabet; null for anything else. */
export function languageOfKey(key: string): 'ru' | 'en' | null {
  if (key.length !== 1) return null
  if (/[а-яё]/i.test(key)) return 'ru'
  if (/[a-z]/i.test(key)) return 'en'
  return null
}

/** The language a keyboard map types in, read from the key left of W. */
export function languageOfLayout(map: ReadonlyMap<string, string>): 'ru' | 'en' | null {
  return languageOfKey(map.get('KeyQ') ?? '')
}

async function readMap(): Promise<string | null> {
  const keyboard = (
    navigator as Navigator & {
      keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> }
    }
  ).keyboard
  if (!keyboard?.getLayoutMap) return null
  try {
    return languageOfLayout(await keyboard.getLayoutMap())
  } catch {
    return null
  }
}

async function speaksNatively(): Promise<boolean> {
  if (native === undefined) native = (await window.td.ui.inputLanguage()) !== null
  return native
}

/** The language now, or null when it cannot be told. */
export async function inputLanguage(): Promise<string | null> {
  if (await speaksNatively()) return window.td.ui.inputLanguage()
  return readMap()
}

/** On a Mac, every change of language as it happens. Returns the way to stop. */
export function onInputLanguage(listener: (language: string) => void): () => void {
  return window.td.ui.onInputLanguage(listener)
}

/** For tests: forget whether this machine speaks for itself. */
export function resetInputLanguage(): void {
  native = undefined
}
