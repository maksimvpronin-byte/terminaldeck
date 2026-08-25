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
export function useT(): (text: string) => string {
  const language = useStore((s) => s.settings.language)
  return (text: string) => translate(language, text)
}
