import { ru } from './ru'

export type Language = 'en' | 'ru'

export const LANGUAGES: Array<{ id: Language; name: string }> = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' }
]

/**
 * The English text is the key.
 *
 * A retrofit onto an interface that was written in English, so inventing a
 * second vocabulary of `settings.terminal.font` names would have meant touching
 * every line twice and leaving the source unreadable in between. The cost is
 * that a word used in two senses needs two entries; there are few.
 *
 * A missing entry falls back to the key, so a half-translated screen shows
 * English rather than machine names — a working screen, and visibly an
 * untranslated one.
 */
const DICTIONARIES: Record<Language, Record<string, string>> = { en: {}, ru }

/**
 * `values` fill `{name}` placeholders after the phrase is looked up.
 *
 * Without them a sentence carrying a number or a version has to be assembled
 * from translated fragments, and the fragments only reassemble correctly in the
 * language they were split in: "Version 1.2 is available" and "Доступна версия
 * 1.2" do not put the number in the same place. The whole sentence is the key,
 * and the translation decides where the value goes.
 *
 * A placeholder with no value is left as it is rather than blanked, so a
 * mismatch shows up as `{version}` on screen instead of a hole.
 */
export function translate(
  language: Language,
  text: string,
  values?: Record<string, string | number>
): string {
  const phrase = DICTIONARIES[language]?.[text] ?? text
  if (!values) return phrase
  return phrase.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in values ? String(values[name]) : placeholder
  )
}

/**
 * What the operating system suggests, for a first run with nothing saved.
 *
 * Kept apart from the hook below so the settings module can call it without
 * reaching the store, which would import the settings module back.
 */
export function preferredLanguage(): Language {
  const stated = typeof navigator === 'undefined' ? '' : navigator.language
  return stated.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}
