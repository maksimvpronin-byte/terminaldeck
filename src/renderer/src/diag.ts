import { describeKeyCode, describeModifiers, isModifierCode } from '../../shared/diagnostics'

/**
 * The window's half of the diagnostics journal; the file is kept by the main
 * process, see `main/diagnostics.ts`.
 *
 * Only keys that can explain a stuck session are written: modifiers going down
 * and up, and anything pressed while Ctrl, Alt or Meta is held. A plain letter
 * is not written at all, so nothing typed can be read back out of the journal.
 */
export function diag(source: string, message: string): void {
  try {
    window.td.diag(source, message)
  } catch {
    /* the journal is never worth an exception */
  }
}

export function diagKey(source: string, event: KeyboardEvent, extra = ''): void {
  const m = {
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey
  }
  const combination = m.ctrl || m.alt || m.meta
  if (!isModifierCode(event.code) && !combination) return
  // Auto-repeat of a held modifier says nothing new and would fill the file.
  if (event.repeat && isModifierCode(event.code)) return
  const up = event.type === 'keyup' ? 'up' : 'down'
  diag(
    source,
    `${up} ${describeKeyCode(event.code, m)} mods=${describeModifiers(m)}${extra ? ` ${extra}` : ''}`
  )
}

/**
 * The keys a desktop holds down, as the journal may name them: the modifiers.
 * Every key held went in, a letter among them, and a letter held while a
 * modifier went down was written by its physical key.
 */
export function heldForJournal(held: Iterable<string>, none = '-'): string {
  const all = [...held]
  const named = all.filter(isModifierCode)
  const others = all.length - named.length
  const parts = [...named, ...(others > 0 ? [`${others} other key${others === 1 ? '' : 's'}`] : [])]
  return parts.join(',') || none
}
