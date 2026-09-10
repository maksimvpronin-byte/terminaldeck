// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HelpDialog from './HelpDialog'
import { useStore } from '../state/store'

function inLanguage(language: 'en' | 'ru'): void {
  useStore.setState({ settings: { ...useStore.getState().settings, language } })
}

/**
 * The worked examples in the help are lines to be typed into a file somewhere
 * else, and a translated variable name is a variable that does not work. They
 * are held in a field of their own for that reason, outside the phrase book,
 * and this is what says so.
 */
describe('the examples in the help', () => {
  it('prints the inventory variables exactly as they have to be written', () => {
    inLanguage('en')
    render(<HelpDialog onClose={() => {}} />)
    const shown = screen
      .getAllByText(/terminaldeck_p/)
      .map((el) => el.textContent ?? '')
      .join('\n')
    expect(shown).toContain('terminaldeck_protocol: rdp')
    expect(shown).toContain('terminaldeck_port: 33890')
  })

  it('leaves them alone in Russian, where the prose around them is translated', () => {
    inLanguage('ru')
    render(<HelpDialog onClose={() => {}} />)
    expect(screen.getByText('Инвентарь из git')).toBeInTheDocument()
    expect(screen.getAllByText(/terminaldeck_protocol: rdp/).length).toBeGreaterThan(0)
    inLanguage('en')
  })
})
