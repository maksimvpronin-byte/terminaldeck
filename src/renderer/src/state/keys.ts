/**
 * Which key this application's shortcuts are held down with.
 *
 * On a Mac it is ⌘, and Ctrl is left entirely to whatever has the keyboard —
 * which for a terminal means the shell. Nearly every Ctrl+letter is a readline
 * binding: Ctrl+D ends the session, Ctrl+K kills to the end of the line,
 * Ctrl+W deletes a word, Ctrl+L clears the screen, Ctrl+P walks back through
 * history. Treating Ctrl as a second ⌘ took all of them.
 *
 * Elsewhere there is no ⌘, so the application takes Ctrl+Shift and leaves Ctrl
 * alone — the convention Windows Terminal and MobaXterm follow, and for the
 * same reason. Claiming plain Ctrl there took exactly the keys the comment
 * above lists: this application was announcing that it would not do that on a
 * Mac while doing it everywhere else.
 */
export const IS_MAC = navigator.platform.toLowerCase().includes('mac')

/**
 * Shortcut hints are written in mac notation throughout the UI and rewritten
 * here for other platforms, so a Windows user isn't left decoding ⌘ and ⇧.
 *
 * `⌘` becomes `Ctrl+Shift` rather than `Ctrl`, because that is what the
 * shortcut actually is off a Mac — the hints would otherwise teach the
 * combination that no longer works, and that the shell now receives instead.
 * Digits are the exception in the handler and the exception here: no shell
 * wants Ctrl+1, so tabs stay where they were.
 */
export function keyHint(keys: string): string {
  if (IS_MAC) return keys
  return (
    keys
      .replace(/⌘⇧([1-9])/g, 'Ctrl+Shift+$1')
      .replace(/⌘([1-9])/g, 'Ctrl+$1')
      .replace(/⌘⇧/g, 'Ctrl+Shift+')
      .replace(/⌘/g, 'Ctrl+Shift+')
      .replace(/⇧/g, 'Shift+')
      .replace(/⏎/g, 'Enter')
      // "Ctrl+ / Shift+ click" reads badly; drop a + with nothing after it.
      .replace(/\+(\s|\/|\)|$)/g, '$1')
  )
}
