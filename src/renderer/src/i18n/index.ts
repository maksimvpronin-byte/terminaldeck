import { useStore } from '../state/store'
import { translate } from './language'

export { LANGUAGES, preferredLanguage, translate } from './language'
export type { Language } from './language'

/**
 * Every user-facing string in a component goes through this.
 *
 * A hook rather than a bare function, so changing the language redraws what is
 * on screen instead of waiting for the next reason to render.
 */
export type Translate = (text: string, values?: Record<string, string | number>) => string

export function useT(): Translate {
  const language = useStore((s) => s.settings.language)
  return (text, values) => translate(language, text, values)
}
