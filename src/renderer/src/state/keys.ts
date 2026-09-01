/**
 * Which key this application's shortcuts are held down with.
 *
 * On a Mac it is ⌘, and Ctrl is left entirely to whatever has the keyboard —
 * which for a terminal means the shell. Nearly every Ctrl+letter is a readline
 * binding: Ctrl+D ends the session, Ctrl+K kills to the end of the line,
 * Ctrl+W deletes a word, Ctrl+L clears the screen, Ctrl+P walks back through
 * history. Treating Ctrl as a second ⌘ took all of them.
 *
 * Elsewhere there is no ⌘ and Ctrl is the only modifier an application can
 * reasonably claim, so the same conflict stands unresolved there; see the
 * shortcut list in the README.
 */
export const IS_MAC = navigator.platform.toLowerCase().includes('mac')

/**
 * Shortcut hints are written in mac notation throughout the UI and rewritten
 * here for other platforms, so a Windows user isn't left decoding ⌘ and ⇧.
 */
export function keyHint(keys: string): string {
  if (IS_MAC) return keys
  return (
    keys
      .replace(/⌘⇧/g, 'Ctrl+Shift+')
      .replace(/⌘/g, 'Ctrl+')
      .replace(/⇧/g, 'Shift+')
      .replace(/⏎/g, 'Enter')
      // "Ctrl+ / Shift+ click" reads badly; drop a + with nothing after it.
      .replace(/\+(\s|\/|\)|$)/g, '$1')
  )
}
