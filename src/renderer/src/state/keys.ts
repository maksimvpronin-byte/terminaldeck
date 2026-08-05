const IS_MAC = navigator.platform.toLowerCase().includes('mac')

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
