// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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
    fireEvent.click(screen.getByRole('button', { name: 'Inventory from git' }))
    const shown = screen
      .getAllByText(/terminaldeck_p/)
      .map((el) => el.textContent ?? '')
      .join('\n')
    expect(shown).toContain('terminaldeck_protocol: rdp')
    expect(shown).toContain('terminaldeck_port: 33890')
  })

  it('says which build this is, at the top where a bug report starts', () => {
    inLanguage('en')
    render(<HelpDialog onClose={() => {}} />)
    expect(screen.getByText('0.0.0-test')).toBeInTheDocument()
  })

  it('leaves them alone in Russian, where the prose around them is translated', () => {
    inLanguage('ru')
    render(<HelpDialog onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Инвентарь из git' }))
    expect(screen.getByRole('heading', { name: 'Инвентарь из git' })).toBeInTheDocument()
    expect(screen.getAllByText(/terminaldeck_protocol: rdp/).length).toBeGreaterThan(0)
    inLanguage('en')
  })
})

/**
 * One page per subject, so a shortcut described on its subject's page has to
 * be findable without knowing which page that is.
 */
describe('finding your way round the help', () => {
  it('opens on every shortcut there is, gathered from all the pages', () => {
    inLanguage('en')
    render(<HelpDialog onClose={() => {}} />)
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    // One from the tabs page, one from the snippets page, one from the desktops'.
    expect(screen.getByText('Split the pane to the right')).toBeInTheDocument()
    expect(screen.getByText(/Snippet palette/)).toBeInTheDocument()
    expect(screen.getByText(/Ctrl\+Alt\+Del on the far side/)).toBeInTheDocument()
  })

  it('searches every page, in the language it is read in', () => {
    inLanguage('ru')
    render(<HelpDialog onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Поиск по справке'), {
      target: { value: 'туннел' }
    })
    expect(screen.getByRole('heading', { name: 'Результаты поиска' })).toBeInTheDocument()
    expect(screen.getAllByText(/туннел/i).length).toBeGreaterThan(0)
    fireEvent.change(screen.getByPlaceholderText('Поиск по справке'), {
      target: { value: 'zzzz' }
    })
    expect(screen.getByText('Ничего не найдено.')).toBeInTheDocument()
    inLanguage('en')
  })
})
