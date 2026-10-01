/**
 * This machine's input language, for a desktop to follow.
 *
 * On a Mac the main process knows it — a native module hears every change the
 * moment macOS makes it — and that is passed through unchanged. Anywhere else
 * nothing told the window, so a desktop never learned the language had changed:
 * letters went over in the new one, as characters, while the far taskbar went
 * on showing the old one, and on Windows that is the indicator people read.
 *
 * Off a Mac it is worked out here, two ways:
 *
 * - from the keyboard map Chromium keeps (`navigator.keyboard.getLayoutMap`),
 *   asked every so often while the window has focus, which knows at once and
 *   before anything is typed;
 * - from the letters themselves: a Cyrillic letter is Russian and a Latin one
 *   English, whatever anything else said. What is typed is the truth this
 *   whole arrangement exists to keep the far side in step with.
 *
 * The map is believed only when it changes. Should it ever lag behind the
 * system, an answer it keeps repeating does not undo what a typed letter just
 * proved.
 *
 * Russian and English alone: the far side is moved with Alt+Shift, which is
 * "the next language", and that is only the right one between two.
 */

type Listener = (language: string) => void

const listeners = new Set<Listener>()
/** Off a Mac: the language last worked out here; null until something says. */
let local: string | null = null
/** What the keyboard map said last time it was asked. */
let lastMapped: string | null = null
let poll: number | undefined
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

function announce(language: string): void {
  if (language === local) return
  local = language
  for (const listener of listeners) listener(language)
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

async function check(): Promise<void> {
  if (!document.hasFocus()) return
  const mapped = await readMap()
  if (mapped === lastMapped) return
  lastMapped = mapped
  if (mapped) announce(mapped)
}

async function speaksNatively(): Promise<boolean> {
  if (native === undefined) native = (await window.td.ui.inputLanguage()) !== null
  return native
}

/** The language now, or null when it cannot be told. */
export async function inputLanguage(): Promise<string | null> {
  if (await speaksNatively()) return window.td.ui.inputLanguage()
  if (local === null) {
    lastMapped = await readMap()
    local = lastMapped
  }
  return local
}

/** Every change of language, as it is found out. Returns the way to stop. */
export function onInputLanguage(listener: Listener): () => void {
  const stopNative = window.td.ui.onInputLanguage(listener)
  listeners.add(listener)
  void speaksNatively().then((yes) => {
    if (yes || poll !== undefined || listeners.size === 0) return
    poll = window.setInterval(() => void check(), 400)
  })
  return () => {
    stopNative()
    listeners.delete(listener)
    if (listeners.size === 0 && poll !== undefined) {
      window.clearInterval(poll)
      poll = undefined
    }
  }
}

/** A letter was typed: off a Mac, it says which language is in use. */
export function noteTyped(key: string): void {
  if (native !== false) return
  const language = languageOfKey(key)
  if (language) announce(language)
}

/** For tests: forget everything worked out so far. */
export function resetInputLanguage(): void {
  listeners.clear()
  local = null
  lastMapped = null
  native = undefined
  if (poll !== undefined) window.clearInterval(poll)
  poll = undefined
}
